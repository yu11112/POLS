# Runes Mint Monitor

A zero-build static page that tells you the **sat/vB you need to land a Bitcoin
Runes mint in the next block**, geared towards runes you're watching on
[Bound Launchpad](https://app.bound.exchange/launchpad/).

## What it does

- **Live BTC tip + next-block fee** from
  [`mempool.space`](https://mempool.space/docs/api) (REST + WebSocket).
- **Rune metadata** (terms.amount / cap / mints / height window) from
  [`ordinals.com`](https://docs.ordinals.com/) `/rune/{NAME}`.
- **Mint cost calculator** — `next-block sat/vB × tx vBytes × repeats`,
  with optional BTC/USD for a $ figure.
- **Watch list** in `localStorage` so you can keep a few runes pinned and watch
  their fill rate.
- **Latency analysis** of "Bound vs Bitcoin tip" — measures how many seconds
  after a block timestamp we (the page) detect it via the mempool.space WS.

## Why it isn't directly hitting Bound

Bound's launchpad list isn't exposed as a public, anon-friendly API at the
moment (the route `/launchpad/<runeId>` exists but the index 308-redirects and
the data is loaded client-side from internal endpoints). So the workflow is:

1. On Bound launchpad, copy the rune URL or its name.
2. Paste it into this page → see fee + mint progress.
3. Hit "⭐ 加入关注" to keep it on your dashboard.

When a new BTC block lands, both the top stats and every watched rune
auto-refresh.

## Running locally

It's a pure static page, no build step:

```bash
cd runes-mint-monitor
python3 -m http.server 8000
# open http://localhost:8000
```

Or just open `index.html` directly in a browser. (Some browsers may block
`fetch` from `file://` to `https://`; if so, use the local server.)

## Latency / "can I mint right after a BTC block?" answer

Short version: **yes, you can**. The full reasoning is rendered inside the
page in the "⏱️ Bound 与比特币区块的延迟分析" section. Key points:

- Bound is a frontend + indexer; it doesn't gatekeep what miners include.
- The single number that matters for "next block inclusion" is
  `mempool-blocks[0].feeRange[0]` (the lowest sat/vB that still makes it into
  the next block template at this moment).
- Bound's UI typically lags 1–5s behind a fresh block while it re-indexes; if
  you broadcast directly through your own wallet you don't pay that lag.
- If Bound batches mints server-side, you eat their queue interval (5–30s)
  and probably won't beat solo broadcasters into N+1.

## License

Same as parent repo (MIT).
