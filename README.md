# makefun-tiny-bot-solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/skipsektestnet/makefun-tiny-bot-solana/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/skipsektestnet/makefun-tiny-bot-solana/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for hourly Solana bars that beats buy-and-hold by only holding what is actually rising. Long only, no leverage, no shorts, no network, no randomness — the same bars always give the same orders.

## Strategy

- **Trend filter:** EMA(8) above EMA(21) on each symbol's own closes.
- **Breadth filter:** entries only when at least 4 of the 7 symbols are uptrending, so a lone bounce in a falling market never gets bought.
- **Rotation:** every 6 bars, hold the top 3 symbols by trailing 24-bar return among the uptrending ones with a positive return, 25% of equity each (the weight cap) — at most 75% invested, fully in cash when the market falls.
- **Exits, checked every bar:** trend flips down, 5% stop-loss, or 10% take-profit (a symbol still rising is simply bought again at the next rotation).

## Local grade (dev window, 136 hourly bars, $10,000 capital)

`node cli/makefun.mjs grade-local --kit . --bot . --driver process`

- Net PnL **−$276.16** (−2.76%), vs buy-and-hold **−$869.34** (−8.69%) on the same window — beats the baseline by **$593.18**
- Max drawdown 2.76% (guardrail: ≤25%), 16 trades (guardrail: ≥8), 0 rejected orders
- Deterministic: two runs produce byte-identical action logs

## Run it

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. `vendor/makefun-bars.ts` is the kit's bars-replay/v1 shim, copied unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jeq52989&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
