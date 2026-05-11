# Mockoon coverage for lifeops scenarios

When `LIFEOPS_USE_MOCKOON=1` (the default in `bun run lifeops:full` once
W1-5 wires it through), the 18 Mockoon environments below auto-start via
`scripts/lifeops-mockoon-bootstrap.mjs` and connector base URLs are rewritten
to `http://127.0.0.1:<port>` by
`plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts:applyMockoonEnvOverrides()`.

This file maps environments to the scenarios that exercise them today, and
calls out gaps where a scenario *should* hit Mockoon but currently uses an
inline seed instead.

For per-connector endpoint inventories, base URLs, and env-var overrides see
`INVENTORY.md` next to this file.

## Environments

| Env             | Port  | Mocks                                                                                     | Used by scenarios |
| --------------- | ----: | ----------------------------------------------------------------------------------------- | ----------------- |
| gmail           | 18801 | Gmail API v1 (messages list/get/send, drafts, threads, labels, modify)                    | `lifeops.inbox-triage/inbox-triage.thread-with-draft`, `lifeops.morning-brief/morning-brief.urgent-mid-brief`, `lifeops.security/security.prompt-injection-inbox`, plus every scenario under `test/scenarios/messaging.gmail/` (15 scenarios) and the gmail-touching scenarios in `test/scenarios/executive-assistant/` |
| calendar        | 18802 | Google Calendar v3 (calendarList, events list/get/insert/patch/delete)                    | `lifeops.calendar/calendar.reschedule.dst-fall-back`, `lifeops.planner/planner.tool-search-empty`, `lifeops.planner/planner.tool-search-wrong`, `lifeops.workflow-events/workflow.event.calendar-ended.*` (3 scenarios), plus `test/scenarios/calendar/` (14 scenarios) |
| slack           | 18803 | Slack Web API (chat.postMessage, conversations.list/history, users.list, reactions.add)   | reserved for future slack connector tests; no lifeops.* scenario hits slack today |
| discord         | 18804 | Discord REST v10 (guilds, channels, messages list/post)                                   | `test/scenarios/messaging.discord-local/` (3 scenarios), `test/scenarios/gateway/discord-gateway.bot-routes-to-user-agent` |
| telegram        | 18805 | Telegram Bot API (sendMessage, getUpdates, getMe, sendChatAction)                         | every `lifeops.habits/*` scenario (6 total), `lifeops.morning-brief/morning-brief.urgent-mid-brief`, `lifeops.reminders/reminders.apple-permission-denied`, `test/scenarios/messaging.telegram-local/` (3 scenarios) |
| github          | 18806 | GitHub REST (search/issues, repos/issues, repos/pulls, repos/commits)                     | reserved for future github connector tests; no lifeops.* scenario hits github today |
| notion          | 18807 | Notion API v1 (search, pages create, blocks children, databases get)                      | reserved for future notion connector tests; no lifeops.* scenario hits notion today |
| twilio          | 18808 | Twilio Programmable Messaging + Voice (`Messages.json`, `Calls.json`)                     | `test/scenarios/gateway/twilio.*` (3 scenarios) |
| plaid           | 18809 | Plaid via Eliza Cloud relay (`/v1/eliza/plaid/link-token`, `exchange`, `sync`)            | `lifeops.payments/payments.plaid-mfa-fail`, `test/scenarios/payments/` (2 scenarios) |
| apple-reminders | 18810 | Local reminders bridge (lists, reminders CRUD)                                            | `lifeops.reminders/reminders.apple-permission-denied`, `test/scenarios/reminders/` apple-touching cases |
| bluebubbles     | 18811 | BlueBubbles server REST (chat, message text send)                                         | `test/scenarios/gateway/bluebubbles.*` (2 scenarios), iMessage scenarios under `test/scenarios/messaging.imessage/` |
| ntfy            | 18812 | `POST /{topic}` publish                                                                   | indirect — any scenario that exercises `notifications-push.ts` |
| duffel          | 18813 | Duffel air search (offer_requests, offers, orders)                                        | reserved; no lifeops.* scenario hits duffel today |
| anthropic       | 18814 | Anthropic Messages API — failure-injection only (429/529/500 via fault toggles)           | `lifeops.planner/planner.action-timeout`, `lifeops.planner/planner.invalid-json-retry` (when ANTHROPIC_BASE_URL points here) |
| cerebras        | 18815 | OpenAI-compatible chat.completions + embeddings (Cerebras deployment)                     | every scenario uses this through `OPENAI_BASE_URL` when LIFEOPS_USE_MOCKOON=1 and Cerebras is the planner/eval model |
| eliza-cloud     | 18816 | Eliza Cloud relay (auth/token, agents/me, billing/balance, plaid/paypal/schedule mirrors) | `test/scenarios/gateway/billing.*`, any scenario using cloud-managed clients |
| spotify         | 18817 | Spotify Web API (`/v1/me`, `/v1/me/player/currently-playing`)                             | reserved for future spotify connector tests |
| signal          | 18818 | signal-cli REST (`/v1/receive/{account}`, `/v2/send`)                                     | `lifeops.morning-brief/morning-brief.empty-inbox`, `lifeops.planner/planner.action-timeout`, `lifeops.reminders/reminders.apple-permission-denied`, `lifeops.sleep/sleep.apple-vs-oura-conflict`, `test/scenarios/messaging.signal/` (2 scenarios) |

## Scenarios with no Mockoon usage today (gaps)

These lifeops.* scenarios do not reference any Mockoon-backed connector by
keyword today. Most use an inline seed or an in-memory fake. Wave-2 follow-up:

- `lifeops.controls/lifeops.device-intent.broadcast-reminder` — should hit
  `ntfy` (push) + `signal`/`telegram` (broadcast).
- `lifeops.controls/lifeops.pause.vacation-window` — should hit `calendar`
  (vacation window source of truth).
- `lifeops.documents/documents.ocr-fail` — should hit `eliza-cloud`
  (documents API is a cloud surface).
- `lifeops.planner/planner.invalid-json-retry` — uses inline planner stub;
  should swap to `anthropic` (port 18814) failure-injection toggle for the
  retry-loop regression case.

The non-lifeops trees that still need a Mockoon pass (out of scope for W1-4,
recorded so we don't lose it):

- `test/scenarios/relationships/` — `gmail`/`telegram`/`discord` follow-up
  drafts can ride the existing envs.
- `test/scenarios/todos/` — uses an in-memory store; no external surface, so
  no Mockoon hookup needed.
- `test/scenarios/connector-certification/` — by design exercises each
  connector against the matching Mockoon env; already wired through the
  certification harness.

## How to run

The benchmark runner spawns the Mockoon fleet automatically when
`LIFEOPS_USE_MOCKOON=1` is set (default):

```sh
bun run lifeops:full
```

Opt out for a real-API smoke run when investigating a connector regression:

```sh
LIFEOPS_USE_MOCKOON=0 bun run lifeops:full
```

Manual lifecycle (useful when iterating on a single mock environment):

```sh
node scripts/lifeops-mockoon-bootstrap.mjs --start    # spawn fleet, return
node scripts/lifeops-mockoon-bootstrap.mjs --status   # which ports are UP
node scripts/lifeops-mockoon-bootstrap.mjs --stop     # tear everything down
```

Self-test (verifies bootstrap + redirect helper + gmail loopback path end to
end, including the `X-Mockoon-Fault: rate_limit` toggle):

```sh
node scripts/lifeops-mockoon-smoke.mjs
```

## Prerequisite: mockoon-cli

The bootstrap script resolves the Mockoon binary in this order:

1. `$MOCKOON_BIN` if it points at an existing file.
2. `mockoon-cli` on `$PATH`.
3. A repo-local npx cache at
   `~/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli` (populated by
   any prior `npx @mockoon/cli@latest`).
4. `npx --yes @mockoon/cli@latest` (slow cold start — adds ~30s per env).

Recommended one-time install:

```sh
npm i -g @mockoon/cli@latest
```

…or just let step 4 run once so the npx cache populates.

## How to add a Mockoon env

1. Drop a new `<service>.json` under this directory with a unique top-level
   numeric `port` field. Reuse the 18801–18820 range (avoiding the dev-server
   ports listed in `CLAUDE.md`).
2. Add route handlers for the endpoints the consumer code actually calls.
   Include the three standard fault rules (header `X-Mockoon-Fault: rate_limit`
   → 429, `auth_expired` → 401, `server_error` → 500). The other envs in this
   directory are the templates.
3. Add an entry to `applyMockoonEnvOverrides()` in
   `plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts` for the
   relevant env var or expose a `getMockoonBaseUrl(<connector>)` lookup.
4. Append a row to the table above and to `INVENTORY.md`.
5. Extend `scripts/lifeops-mockoon-smoke.mjs` if the new env covers a path
   that benchmark scenarios depend on.
