# ptt-autosign-worker

Cloudflare Workers port of [PTTAutoSign](https://github.com/tasi788/PTTAutoSign). Currently at **Phase 0 — connectivity spike**. No login flow yet.

## What this currently does

A single endpoint `GET /spike` that:
1. Opens a WebSocket from Workers' edge to `wss://ws.ptt.cc/bbs/` with `Origin: https://term.ptt.cc`.
2. Captures up to 5 seconds of incoming frames.
3. Returns a JSON report: handshake status, frame count, total bytes, hex dump of the first frame, and a Big5-decoded preview.

The whole point is to answer one question before writing any state-machine code: **does Cloudflare's egress reach ws.ptt.cc and complete the handshake?** If not, abandon the rewrite.

## Run the spike

```bash
npm install
npx wrangler login           # one-time, opens browser
npx wrangler deploy
curl https://ptt-autosign-worker.<your-subdomain>.workers.dev/spike | jq
```

Or test against Cloudflare's edge from local without deploying:

```bash
npm run dev      # wrangler dev --remote
curl http://localhost:8787/spike | jq
```

> `--local` mode is intentionally **not** used — local workerd may handle outbound WebSocket differently from Cloudflare's edge. We need the real egress path tested.

## Interpreting the result

| `handshake.status` | Meaning | Next step |
|---|---|---|
| `101` + non-empty `decoded` containing CJK ("請輸入代號" or similar) | **GREEN** — proceed to Phase 1 | Vendor `terminal.js` + port `ptt-client/socket.ts` and `bot.ts:checkLogin` |
| `101` + empty/garbage decode | YELLOW — handshake works but framing is off | Inspect `firstFrameHex`; may need `Sec-WebSocket-Protocol` header tweaks |
| `403` / `451` | **RED** — PTT is blocking Cloudflare ASN | Abandon Plan B. Fall back to Plan A (GitHub Actions cron). |
| `error: TypeError` / `Network` | RED — Workers can't reach ws.ptt.cc at all | Investigate compat date / fetch-upgrade behavior |

## Roadmap (only if Phase 0 is green)

| Phase | Scope | Source of truth |
|---|---|---|
| 1 | Vendor `terminal.js` (zero-dep VT100 parser) | `github.com/kevinptt0323/terminal.js` |
| 2 | Workers WebSocket adapter that mimics browser `new WebSocket(url)` | New, ~50 LOC |
| 3 | Port `ptt-client/socket.ts` + login subset of `bot.ts` (`checkLogin` covers all six PTT prompt edge cases) | `github.com/kevinptt0323/ptt-client` |
| 4 | Multi-account loop, Telegram fetch, error taxonomy | New |
| 5 | Cron Trigger, secrets, observability via `wrangler tail` | `wrangler.toml` |

## Reference packages

These are the npm packages the full rewrite would lean on (all MIT, all confirmed Workers-compatible — pure JS, no `node:net`/`node:tls`/`Buffer`):

- `kevinptt0323/ptt-client` — login state machine and PTT screen parsing (last published 2020-01-02, will need verification against current PTT)
- `kevinptt0323/terminal.js` (fork of `Gottox/terminal.js`) — VT100/ANSI emulator, zero runtime deps
- `uao-js`, `wcwidth`, `eventemitter3`, `sleep-promise` — small pure-JS utilities

## Secrets (when needed, not yet)

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put PTT_ACCOUNTS   # JSON: [{"id":"foo","password":"bar"}, ...]
```
