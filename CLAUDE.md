# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker (no runtime dependencies, no `nodejs_compat`) that logs into PTT accounts daily over `wss://ws.ptt.cc/bbs/`, scrapes login count / mail status / last-login IP, logs out, and reports each account to Telegram. Port of the Python [PTTAutoSign](https://github.com/tasi788/PTTAutoSign). Worker name is `ptt-autosign`; repo name is `ptt-autosign-worker`.

## Commands

```bash
npm run typecheck   # tsc --noEmit (covers src/ and test/)
npm run lint        # oxlint, warnings fail
npm run format      # oxfmt (defaults, width 100); CI runs format:check
npm test            # vitest inside workerd via @cloudflare/vitest-plugin
npm test -- --coverage   # istanbul → coverage/lcov.info (what CI uploads to Codecov)
npx vitest run test/ptt.test.ts -t "repeated any-key"   # one file / one test
npm run dev         # wrangler dev --remote (remote: PTT must be reached from Cloudflare's network)
npm run deploy      # wrangler deploy
npm run tail        # stream production logs
```

Manual verification is against the deployed Worker (both routes need `Authorization: Bearer <RUN_TOKEN>`):
- `GET /spike` — opens a WebSocket to PTT and dumps the Big5-decoded welcome banner, no login. Use it to check connectivity.
- `POST /run` — runs the same flow as the cron and returns per-account JSON (`ok`, `reason`, `loginCount`, `mailStatus`, `lastLoginIp`, `elapsed_ms`, and `screen` on login failure). It also sends real Telegram messages and logs in to real accounts.

Secrets (`wrangler secret put`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_TOPIC_ID` (forum topic → `message_thread_id`), `PTT_ACCOUNTS` (JSON `[{"id":"...","password":"..."}]`), `RUN_TOKEN`. Don't put credentials in URLs. A `/test-login` route was removed for that reason (access logs).

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check and tests with coverage on push to `main` and on PRs, then uploads to Codecov via OIDC (no token secret).

## Architecture

- `src/index.ts` — routes, `scheduled()` (cron `30 2 * * *` in `wrangler.toml`), the sequential multi-account loop, and Telegram message formatting (HTML parse mode, so user-derived strings go through `htmlEscape`). A failure for one account, including a Telegram send error, is recorded and the loop continues to the next account.
- `src/ptt.ts` — two layers:
  - `PttSocket`: outbound WebSocket via `fetch` with `Upgrade: websocket` and `Origin: https://term.ptt.cc`. Frames may arrive as ArrayBuffer or Blob, so they are queued as promises and `drain()` must run before reading buffers. Every frame is fed to **both** a Big5 and a UTF-8 streaming `TextDecoder`. PTT is Big5 before login and switches to UTF-8 after (triggered by the trailing comma in `username,\r`). ANSI is stripped and each view is kept in a 32 KB rolling buffer. `screen` is the concatenation of the two views and is what prompt matching uses. `waitFor(predicate, timeout)` is the race-safe primitive for waiting on screen text.
  - `PttBot`: `login()` is a polling state machine over substring markers (kick duplicate session, too-frequent login, error-record cleanup, any-key). After answering a prompt it calls `sock.clear()`, so a stale prompt isn't answered twice but a repeated one is still seen. Login succeeds only on `【主功能表】`. `getUser()` navigates T → Q → id and regex-scrapes the UTF-8 view. `logout()` sends `G\rY\r`.
- `src/telegram.ts` — `sendMessage` wrapper that throws on non-2xx.

## Gotchas when editing PTT logic

- Test PTT flows with `fakePtt()` in `test/ptt.test.ts`: a `WebSocketPair` whose server end scripts PTT's replies, attached through `PttSocket.attach()` and passed into `new PttBot(sock)`. Tests send UTF-8 only; the Big5 (pre-login) path isn't covered.

- **The rolling buffer keeps old screens** unless you call `sock.clear()` (which drains first). Call it before sending a key whose response you'll match on, otherwise a marker can match an earlier screen (e.g. 【主功能表】 from login). `login()` clears after answering each prompt, so grab anything you still need (the banner IP) before that. Don't treat a bare `我是` as logged in; the status bar shows it before the menu renders.
- Don't use `q` to go back to the main menu, because on the main menu it opens the logout dialog. `escapeToMain()` sends ArrowLeft (`\x1B[D`) instead.
- Post-login scraping regexes (`登入次數`, `信箱`, `LAST_LOGIN_IP_RE`) are best-effort. A miss must return `null`, and the matching Telegram line is then left out. A miss must never fail the sign-in.
- **Limits:** `scheduled()` gets 15 min wall-clock on every plan, so waits are cheap. The Free plan's 10 ms CPU per Cron invocation is the real constraint, and every poll decodes frames and scans the buffers. Keep polling and buffer scans lean.
- Login failure `reason` values (`wrong_password`, `server_busy`, `socket_closed`, `timeout`, `exception: …`) appear in Telegram messages and are documented in the README. Keep the README in sync if you change them.

## Conventions

- Keep [CHANGELOG.md](CHANGELOG.md) updated (Keep a Changelog format, `[Unreleased]` section).
- Commit messages follow conventional style (`feat:`, `fix(ptt):`, `perf(timing):`, `docs:`).
