// Tiny Bot — trend + cross-sectional momentum rotation on hourly Solana bars.
//
// Idea: buy-and-hold wins when the market rises and loses when it falls, so the
// bot only holds symbols that are actually rising, and only the strongest few —
// and only when the rise is broad, not a lone bounce in a falling market. Each
// symbol gets a fast/slow EMA trend filter; every few bars the bot rotates into
// the top symbols by trailing 24-hour return among the uptrending ones, and
// sits in cash when nothing qualifies. A fixed 5% stop-loss caps the damage of
// any single position. Long only, no leverage, no shorts, no randomness, no
// clock, no network — the same bars always give the same orders.
//
//   - Trend: EMA(8) above EMA(21) on the symbol's own closes, seeded with the
//     mean of the first span of closes, exactly like the house EMA baseline.
//   - Breadth: entries only when at least 4 of the 7 symbols are uptrending,
//     so a single bouncing name in a broad downtrend never gets bought.
//   - Rank: trailing 24-bar return, best first; only positive returns qualify.
//   - Rotation: every 6 tradable bars, hold at most 3 symbols, 25% of equity
//     each (the weight cap), so the bot is at most 75% invested and fully in
//     cash when the market is falling.
//   - Exit, checked every bar: the trend flips down, the position is worth 5%
//     less than it cost, or it is worth 10% more (bank the gain; a symbol
//     still rising is simply bought again at the next rotation). A sell's
//     proceeds never fund a buy in the same reply, so buys that follow a sell
//     wait one batch.
//   - Slippage is capped at 100 bps past the close the order was decided on.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const LOOKBACK_BARS = 24;
const TOP_N = 3;
const REBALANCE_EVERY = 6;
const MIN_BREADTH = 4;
const STOP_NUM = 95n;
const STOP_DEN = 100n;
const TAKE_NUM = 110n;
const TAKE_DEN = 100n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  closes: number[];
  /** fast above slow after the latest bar, null until both EMAs are seeded. */
  up: boolean | null;
}

const series = new Map<string, Series>();
/** Tradable batches seen (warm-up batches never reach here). */
let tradable = 0;
/** Symbols to buy on the next batch, once the sells of this reply have filled. */
let pendingBuys: string[] | null = null;

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): void {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      closes: [],
      up: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.closes.push(c);
  if (s.fast.value !== null && s.slow.value !== null) s.up = s.fast.value > s.slow.value;
}

/** The symbols to hold: uptrending, positive 24-bar return, best first, at most TOP_N.
 *  Empty unless the uptrend is broad (MIN_BREADTH symbols rising), so a lone
 *  bounce in a falling market never gets bought. */
function rank(state: BarsState): string[] {
  let breadth = 0;
  for (const { symbol } of state.hello.symbols) if (series.get(symbol)?.up === true) breadth++;
  if (breadth < MIN_BREADTH) return [];
  const scored: { symbol: string; ret: number }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const s = series.get(symbol);
    if (s === undefined || s.up !== true) continue;
    const c = s.closes;
    if (c.length <= LOOKBACK_BARS) continue;
    const now = c[c.length - 1]!;
    const then = c[c.length - 1 - LOOKBACK_BARS]!;
    if (then <= 0 || now <= then) continue;
    scored.push({ symbol, ret: now / then });
  }
  scored.sort((a, b) => (b.ret - a.ret) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return scored.slice(0, TOP_N).map((x) => x.symbol);
}

/** Equal-weight buys of the symbols not already held, sized from cash on hand. */
function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const room = Math.min(TOP_N, caps.max_open_positions) - state.positions.size;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null).slice(0, room > 0 ? room : 0);
  if (coming.length === 0) return [];
  const even = state.equity / BigInt(TOP_N);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const slice = even < byWeight ? even : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  const orders: BuyInput[] = [];
  let cash = state.cash;
  for (const symbol of coming) {
    if (orders.length >= caps.max_orders_per_bar) break;
    const amount = cash < slice ? cash : slice;
    if (amount < BigInt(fees.min_notional_quote_units)) break;
    orders.push({ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
    cash -= amount;
  }
  return orders;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];
    tradable++;
    const { caps } = state.hello;

    // Exits, checked every bar: trend flipped down, the 5% stop-loss hit,
    // or the 10% take-profit reached.
    const sells: SellInput[] = [];
    for (const [symbol, held] of state.positions) {
      const s = series.get(symbol);
      const trendDown = s !== undefined && s.up === false;
      const value = state.value(symbol, held.qty);
      const stopped = value * STOP_DEN <= held.cost * STOP_NUM;
      const tookProfit = value * TAKE_DEN >= held.cost * TAKE_NUM;
      if (trendDown || stopped || tookProfit) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    // Buys deferred from a rebalance whose sells went out last batch.
    if (pendingBuys !== null) {
      if (sells.length > 0) return sells.slice(0, caps.max_orders_per_bar);
      const orders = buys(state, pendingBuys);
      pendingBuys = null;
      return orders;
    }

    if (tradable % REBALANCE_EVERY !== 0) return sells.slice(0, caps.max_orders_per_bar);

    // Rebalance bar: rotate into the strongest uptrending symbols.
    const target = rank(state);
    const held = new Set(state.positions.keys());
    for (const symbol of held) {
      if (!target.includes(symbol) && !sells.some((o) => o.symbol === symbol)) {
        const p = state.positions.get(symbol)!;
        sells.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    if (sells.length > 0) {
      pendingBuys = target.filter((s) => !held.has(s));
      return sells.slice(0, caps.max_orders_per_bar);
    }
    return buys(state, target.filter((s) => !held.has(s)));
  },
});
