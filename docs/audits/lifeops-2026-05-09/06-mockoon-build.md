# Lifeops Mockoon build — 2026-05-09

Goal: every external HTTP call lifeops makes has a Mockoon environment so the
planner can be tested + trained against realistic data without hitting real
APIs. Activated by `LIFEOPS_USE_MOCKOON=1`; opt-in only.

## What shipped

### Environments (18, all under `eliza/test/mocks/mockoon/`)

| File                   | Port  | Routes | Notes                                             |
| ---------------------- | ----- | ------ | ------------------------------------------------- |
| `gmail.json`           | 18801 | 8      | Hand-authored. Covers messages.list/get, threads.list/get, drafts.create/send, labels.list, messages.modify. |
| `calendar.json`        | 18802 | 6      | calendarList, events.list/get/insert/patch/delete.|
| `slack.json`           | 18803 | 6      | chat.postMessage, conversations.list/history, users.list, chat.update, reactions.add. |
| `discord.json`         | 18804 | 4      | users/@me/guilds, guild channels, message list+POST. |
| `telegram.json`        | 18805 | 4      | sendMessage, getUpdates, getMe, sendChatAction.   |
| `github.json`          | 18806 | 5      | search/issues, repo issues/pulls/commits, issue create. |
| `notion.json`          | 18807 | 4      | search, pages.create, blocks.children.append, databases.get. |
| `twilio.json`          | 18808 | 2      | Messages.json, Calls.json. Already wired through `ELIZA_MOCK_TWILIO_BASE`. |
| `plaid.json`           | 18809 | 3      | link-token, exchange, sync (Eliza Cloud relay shape). |
| `apple-reminders.json` | 18810 | 4      | lists, list items, create, complete (bridge HTTP shim shape). |
| `bluebubbles.json`     | 18811 | 3      | api/v1 chats, messages, message/text.             |
| `ntfy.json`            | 18812 | 1      | POST topic. Already wired through `NTFY_BASE_URL`.|
| `duffel.json`          | 18813 | 3      | offer_requests, offers, orders. Direct mode wired through new `LIFEOPS_DUFFEL_API_BASE`. |
| `anthropic.json`       | 18814 | 2      | Failure-injection only. Default response is 503 with a clear "use cerebras for happy path" message. |
| `cerebras.json`        | 18815 | 2      | OpenAI-compatible chat.completions + embeddings. Wired through `OPENAI_BASE_URL`. |
| `eliza-cloud.json`     | 18816 | 6      | auth/token, agents/me, billing/balance, plaid mirror, paypal/authorize, schedule/sync. Wired through `ELIZAOS_CLOUD_BASE_URL`. |
| `spotify.json`         | 18817 | 2      | me, currently-playing.                            |
| `signal.json`          | 18818 | 2      | v1/receive, v2/send (signal-cli REST shape). Wired through `SIGNAL_HTTP_URL`. |

Every non-anthropic environment ships a happy-path default response plus three
fault variants (`rate_limit` -> 429, `auth_expired` -> 401, `server_error` ->
500) selectable via `X-Mockoon-Fault: <fault>` header or `?_fault=<fault>` query
param. Fault bodies match each provider's real error shape (Slack `{ ok:false,
error:"..." }`, Notion `{ object:"error", code:... }`, Plaid `{ error_type,
error_code, error_message }`, etc.).

### Connector wiring

- `eliza/plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts` —
  exports `applyMockoonEnvOverrides()` and `getMockoonBaseUrl(connector)`.
  Sets every base-URL env var that an existing resolver reads:
  - `ELIZA_MOCK_GOOGLE_BASE` (gmail+calendar via plugin-google's existing hook)
  - `ELIZA_MOCK_TWILIO_BASE` (existing)
  - `NTFY_BASE_URL` (existing)
  - `ELIZAOS_CLOUD_BASE_URL` (covers plaid + paypal + schedule-sync via the
    cloud relay)
  - `SIGNAL_HTTP_URL` (existing)
  - `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` (SDK-standard)
  - `LIFEOPS_DUFFEL_API_BASE` (new — direct mode in
    `lifeops/travel-adapters/duffel.ts` now consults this).
- `eliza/plugins/app-lifeops/src/plugin.ts` — calls
  `applyMockoonEnvOverrides()` at the top of the plugin `init` so any
  downstream module that reads env at construction time picks up the override.
- `eliza/plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts` —
  one-line patch: `const DUFFEL_API_BASE = "..."` became
  `getDuffelApiBase()` which honours `LIFEOPS_DUFFEL_API_BASE`. No behavioural
  change when the env var is unset.

### Orchestration

- `start-all.mjs` — spawns every `*.json` in the directory in parallel,
  writes per-env logs to `.mockoon-logs/`, pids to `.mockoon-pids/`, and
  blocks until each port binds (or times out at 10s and returns non-zero).
- `stop-all.mjs` — reads pids and SIGTERMs, then SIGKILLs after 2s.
- `_generate.mjs` — programmatic generator for the 17 non-gmail envs. Hosts
  the realistic personas (Priya Raman, Marcus Okafor, Mei Tanaka, Sasha
  Kowalski, Diego Alvarez) and provider-shaped fault bodies in one place.
  Re-run after editing to regenerate.

## Verification

Smoke test on 2026-05-09 (run with the cached `mockoon-cli` binary at
`~/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli`):

- `gmail.json` on port 18801:
  - `GET /gmail/v1/users/me/messages?q=is:unread` -> 200 + 4-message list
  - `X-Mockoon-Fault: rate_limit` -> 429
  - `?_fault=auth_expired` -> 401
  - `X-Mockoon-Fault: server_error` -> 500
  - `GET /gmail/v1/users/me/messages/<id>` -> 200 + realistic Priya thread
  - `GET /gmail/v1/users/me/labels` -> 200 + 5 labels including
    `lifeops/triaged` user labels
- `calendar.json` on port 18802:
  - `GET /calendar/v3/users/me/calendarList` -> 200 + primary + team-milady
  - `GET /calendar/v3/calendars/primary/events` -> 200 + 2-event list
    (Standup, Q3 OKR review)
  - `X-Mockoon-Fault: rate_limit` -> 429
  - `?_fault=auth_expired` -> 401

Lifeops plugin typecheck (`tsc --noEmit -p tsconfig.build.json`) passes after
the wiring + redirect helper.

## Backlog / what's stubbed

These environments shipped as minimal-viable mocks and are noted in
`INVENTORY.md`'s backlog section:

- `discord.json` — message structure is minimal; threads + embeds are not modelled.
- `notion.json` — only the most-used `search`, `pages.create`,
  `blocks.children.append`, `databases.get` are covered.
- `apple-reminders.json` — bridge HTTP shape is approximated based on the
  existing `apple-reminders.ts` consumer; the real bridge uses WebSockets
  for some configurations.
- `bluebubbles.json` — chat list + message send only; attachments are not
  modelled.
- `signal.json` — 1:1 send/receive only; no group operations.
- `spotify.json` — `me` + `currently-playing` only.
- `anthropic.json` — failure-injection only by design (per the task spec).

Connectors NOT covered yet because they have no direct lifeops fetch site (they
go through the runtime model layer or are not exercised by current actions):

- OpenAI (use `cerebras.json` since both speak OpenAI-compatible chat
  completions; `OPENAI_BASE_URL` already routes there).
- xAI / x.com — runtime model provider; no lifeops-side direct fetch.
- WhatsApp Cloud API (`@elizaos/plugin-whatsapp`) — not exercised.
- WeChat (`@elizaos/plugin-wechat`) — local-only; not external.

Wiring caveats (one-line patches needed in the relevant plugin once tests
exercise these paths):

- `@elizaos/plugin-slack` does not honour an env-var override on its WebClient
  base URL — the redirect helper exposes `getMockoonBaseUrl("slack")` so the
  test must thread it into the WebClient constructor.
- `@elizaos/plugin-discord` (discord.js REST) — same situation; thread
  `getMockoonBaseUrl("discord")` into the REST client `api` option.
- `@elizaos/plugin-github` (Octokit) — pass `getMockoonBaseUrl("github")` as
  `baseUrl` to the Octokit constructor.
- `@elizaos/plugin-telegram` (Telegraf) — thread
  `getMockoonBaseUrl("telegram")` through Telegraf's `apiRoot` option.

The redirect helper exposes these getters but does not patch the plugins
because doing so requires knowing which test harness is running. The
follow-up is straightforward: in each plugin's account-auth-service or
client-factory, read a new env var (e.g. `ELIZA_MOCK_<PROVIDER>_BASE`) the
same way `plugin-google`'s `client-factory.ts:20` already does for Google.

## Files touched

Created:

- `/Users/shawwalters/milaidy/eliza/test/mocks/mockoon/INVENTORY.md`
- `/Users/shawwalters/milaidy/eliza/test/mocks/mockoon/_generate.mjs`
- `/Users/shawwalters/milaidy/eliza/test/mocks/mockoon/start-all.mjs`
- `/Users/shawwalters/milaidy/eliza/test/mocks/mockoon/stop-all.mjs`
- `/Users/shawwalters/milaidy/eliza/test/mocks/mockoon/{gmail,calendar,slack,discord,telegram,github,notion,twilio,plaid,apple-reminders,bluebubbles,ntfy,duffel,anthropic,cerebras,eliza-cloud,spotify,signal}.json`
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts`
- `/Users/shawwalters/milaidy/eliza/docs/audits/lifeops-2026-05-09/06-mockoon-build.md`

Modified:

- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/src/plugin.ts` —
  imports + calls `applyMockoonEnvOverrides()` at the top of `init`.
- `/Users/shawwalters/milaidy/eliza/plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts` —
  `DUFFEL_API_BASE` const replaced with `getDuffelApiBase()` that honours
  `LIFEOPS_DUFFEL_API_BASE`.
