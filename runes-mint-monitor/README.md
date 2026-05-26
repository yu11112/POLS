# Runes Mint Monitor

A zero-build static page that tells you the **sat/vB you need to land a Bitcoin
Runes mint in the next block**, geared towards runes you're watching on
[Bound Launchpad](https://app.bound.exchange/launchpad/).

## What it does

- **Live BTC tip + next-block fee** from
  [`mempool.space`](https://mempool.space/docs/api) (REST + WebSocket).
- **Rune metadata** (terms.amount / cap / mints / height window) from a small
  fallback chain of public, **CORS-enabled, no-auth** ord HTTP servers:
  1. `https://api.xverse.app/v1/runes/{NAME-or-ID}` (primary; Xverse runs an
     ord-shape JSON server with `Access-Control-Allow-Origin: *`).
  2. `https://ordinals.com/rune/{NAME}` (fallback; **currently disabled** by
     ordinals.com — keeps as a probe in case they re-enable it).
- **Mint cost calculator** — `next-block sat/vB × tx vBytes × repeats`,
  with optional BTC/USD for a $ figure.
- **Watch list** in `localStorage` so you can keep a few runes pinned and watch
  their fill rate.
- **Latency analysis** of "Bound vs Bitcoin tip" — measures how many seconds
  after a block timestamp we (the page) detect it via the mempool.space WS.

## Why we don't use ordinals.com directly

The classic `https://ordinals.com/rune/{NAME}` JSON endpoint that's referenced
in many ord tutorials returns `406 JSON API disabled` as of 2026. The Xverse
team operates their own `ord` HTTP server, exposes it at `api.xverse.app`, and
returns the **same response shape** (`{ entry: { ... }, id, mintable, parent }`),
which is why it's the primary source. If you're behind an enterprise firewall
that blocks `api.xverse.app`, you can swap `RUNE_API_PRIMARY` in `app.js` for
your own ord instance — anything that responds at `/rune/<name>` with that
shape will work.

## Why it isn't directly hitting Bound

Bound's launchpad list isn't exposed as a public, anon-friendly API at the
moment (the route `/launchpad/<runeId>` exists but the index 308-redirects and
the data is loaded client-side from internal endpoints). So the workflow is:

1. On Bound launchpad, copy the rune URL, name, or rune ID (`block:tx`).
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

## Data correctness notes

- `terms.cap` for many runes is `u128::MAX` (≈3.4e38), the protocol "no cap"
  sentinel. JS `Number` cannot represent that — we detect cap ≥ 1e15 and
  display "∞ / 无上限" instead of a meaningless 3.4e38. Remaining-mints math
  uses `BigInt` so the precision survives.
- `terms` itself can be `null` (premine-only runes such as
  `DOG•GO•TO•THE•MOON`). We surface this as "无 mint terms (premine-only)".
- The mint amount field is rendered with explicit `divisibility` handling
  (e.g. amount=1 with divisibility=8 → `0.00000001`, not `0.`).

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
