# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-05-06

### Added

- Capture and report PTT's post-login welcome-banner IP in the Telegram
  success message (`🌐 上次登入來源 <IP>` line) and `/run` JSON
  (`SignInResult.lastLoginIp`). Best-effort; `null` on first-time logins
  or regex miss. The IP shown is Cloudflare's egress (e.g. `172.69.x.x`),
  not the operator's home IP.

## [0.1.0] - 2026-05-04

Initial working release. Cloudflare Workers port of
[PTTAutoSign](https://github.com/tasi788/PTTAutoSign).

### Added

- WebSocket transport to `wss://ws.ptt.cc/bbs/` via `fetch+Upgrade` (no
  browser-style `new WebSocket(url)` required).
- Dual-decoder pipeline (Big5 + UTF-8 in parallel) so substring matches
  survive PTT's mid-stream charset switch.
- ANSI escape stripper + 32 KB rolling text buffer (no full terminal
  emulator, no `nodejs_compat` flag).
- `PttBot.login()` state machine for the six PTT login prompts (kick
  session, rate limit, error-cleanup, any-key continue, login marker
  `我是` / `主功能表`).
- `PttBot.getUser()` best-effort `登入次數` + `信箱狀況` extraction via
  T → Q → username navigation.
- `scheduled()` handler at cron `30 2 * * *` (02:30 UTC).
- `GET /run?secret=<RUN_TOKEN>` manual trigger.
- `GET /spike` connectivity probe (no login).
- Telegram Bot API notifier with HTML-escaped message body.
- Multi-account loop with 2 s inter-account delay.

### Notes

- No runtime dependencies.
- `getUser()` regex is best-effort; nullable fields degrade gracefully
  when PTT layout doesn't match.
- Worker name in `wrangler.toml` is `ptt-autosign`; GitHub repo is
  `ptt-autosign-worker`.

[Unreleased]: https://github.com/7a6163/ptt-autosign-worker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/7a6163/ptt-autosign-worker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/7a6163/ptt-autosign-worker/releases/tag/v0.1.0
