# ptt-autosign-worker

Cloudflare Workers port of [PTTAutoSign](https://github.com/tasi788/PTTAutoSign).
Logs into one or more PTT accounts daily via `wss://ws.ptt.cc/bbs/`, reads
`登入次數` + `信箱狀況`, and reports the result to Telegram.

No terminal emulator, no `nodejs_compat`, no runtime dependencies.

## How it works

A Cloudflare Cron Trigger fires `scheduled()` daily at 02:30 UTC. For each
account in `PTT_ACCOUNTS`, the Worker:

1. Opens an outbound WebSocket to PTT's terminal gateway.
2. Sends `username,\rpassword\r` (the trailing comma triggers PTT's UTF-8
   negotiation).
3. Walks a small login state machine — kicks duplicate sessions, dismisses
   any-key prompts, etc.
4. Navigates `T → Q → username` to scrape `登入次數` and `信箱狀況`.
5. Sends `G\rY\r` to log out.
6. Posts a Telegram message.

Bytes are decoded with **two** `TextDecoder`s in parallel (Big5 + UTF-8) so
the state machine doesn't care which charset PTT happens to be using at any
moment.

## Setup

```bash
npm install
npx wrangler login
npx wrangler deploy

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put PTT_ACCOUNTS    # JSON: [{"id":"alice","password":"..."}]
npx wrangler secret put RUN_TOKEN       # any random string
```

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `GET /spike` | Diagnostic — opens WS to ws.ptt.cc and dumps the welcome banner | none |
| `GET /run?secret=<RUN_TOKEN>` | Manual cron-equivalent trigger | RUN_TOKEN |
| `scheduled()` | Daily 02:30 UTC | Cloudflare Cron Trigger |

```bash
# Smoke test after deploy + secrets
curl "https://ptt-autosign.<sub>.workers.dev/run?secret=<RUN_TOKEN>" | jq
```

## Telegram message format

Success:

```
✅ PTT alice 已成功簽到
📆 已登入 1234 天
📫 信箱中已無新信件
#ptt #20260504
```

Failure:

```
❌ PTT alice 簽到失敗
原因：wrong_password
#ptt #20260504
```

## Failure modes

| `reason` | Cause |
|---|---|
| `wrong_password` | PTT echoed `密碼不對或無此帳號` |
| `server_busy` | PTT echoed `請稍後再試` |
| `socket_closed` | WebSocket closed mid-flow |
| `timeout` | State machine ran past 30 s without seeing the login marker — likely a PTT prompt change. Inspect the `screen` field. |

## Known soft spots

- **`getUser()` regex** — `登入次數》(\d+)` and `信箱[^》]*》` are guesses
  based on the classic PyPtt user-card layout. PTT may use a different
  label format; if `loginCount` and `mailStatus` come back `null` but
  login itself succeeds, the Telegram message just omits those lines.
- **Cron precision** — Cloudflare crons fire within seconds of `02:30 UTC`.
  Add jitter inside `scheduled()` if anti-detection becomes a concern.
- **Free-plan budget** — Timeouts are tuned for a 30-second Free-plan
  scheduled-handler wall-clock. Per account budget: ~10–17 s realistic,
  ~22 s worst case. **Two accounts fit; 3+ accounts likely need the
  Paid plan.** Knobs to adjust in `src/ptt.ts`: the `15_000`-ms login
  deadline and the inner `getUser` waitFor timeouts.

## File layout

```
src/
├── index.ts      Entry: routes + scheduled() + multi-account loop
├── ptt.ts        WebSocket transport + dual decoder + login state machine
└── telegram.ts   Bot API wrapper
```

## License

MIT — same as the original [PTTAutoSign](https://github.com/tasi788/PTTAutoSign).
