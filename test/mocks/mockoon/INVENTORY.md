# Mockoon HTTP mock inventory — lifeops external surface

Goal: every external HTTP call lifeops makes is reproducible against a Mockoon
environment so the planner can be tested + trained against realistic data
without hitting real APIs.

This document maps each connector's:

- Source files in the workspace
- Base URL (constant or env var override)
- The env var the runtime reads to swap to a mock
- Endpoints the consumer code actually calls (method + path + roughly what
  shape it reads back)
- Mockoon environment file + port assignment

Activate the mock layer at runtime with `LIFEOPS_USE_MOCKOON=1`. The redirect
helper at
`eliza/plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts`
returns `http://localhost:<port>` for each known connector when that flag is
set. Each connector's existing base-URL resolver consults the helper before
falling back to the real upstream.

## Port table

Ports start at 18801 and avoid 31337/2138/18789/2142/18790 (the dev-server
ports listed in `CLAUDE.md`). Pick the next free port in this range when adding
a new connector.

| Port  | Connector       | Mockoon env file                    |
| ----- | --------------- | ----------------------------------- |
| 18801 | gmail           | `gmail.json`                        |
| 18802 | calendar        | `calendar.json`                     |
| 18803 | slack           | `slack.json`                        |
| 18804 | discord         | `discord.json`                      |
| 18805 | telegram        | `telegram.json`                     |
| 18806 | github          | `github.json`                       |
| 18807 | notion          | `notion.json`                       |
| 18808 | twilio          | `twilio.json`                       |
| 18809 | plaid           | `plaid.json` (cloud-relay shape)    |
| 18810 | apple-reminders | `apple-reminders.json`              |
| 18811 | bluebubbles     | `bluebubbles.json`                  |
| 18812 | ntfy            | `ntfy.json`                         |
| 18813 | duffel          | `duffel.json`                       |
| 18814 | anthropic       | `anthropic.json` (failure-injection) |
| 18815 | cerebras        | `cerebras.json`                     |
| 18816 | eliza-cloud     | `eliza-cloud.json`                  |
| 18817 | spotify         | `spotify.json`                      |
| 18818 | signal          | `signal.json` (signal-cli rest)     |

## Failure-mode toggle

Every environment ships a happy path on the canonical route and three failure
variants accessible by sending one of these toggles on the request:

- Header `X-Mockoon-Fault: rate_limit` -> 429 (with `Retry-After: 1`)
- Header `X-Mockoon-Fault: auth_expired` -> 401 with provider-shaped error body
- Header `X-Mockoon-Fault: server_error` -> 500
- Query `?_fault=rate_limit|auth_expired|server_error` works the same way for
  callers that cannot inject headers easily (e.g. browser side).

Mockoon "rules" select the response. The default response is the happy path.

## Connector inventory

### 1. gmail (port 18801, file `gmail.json`)

- Source: lifeops talks to Gmail via `@elizaos/plugin-google` (resolved through
  `service-mixin-gmail.ts`, `service-mixin-email-unsubscribe.ts`,
  `email-classifier.ts`). The plugin's `GoogleApiClientFactory` already honours
  `ELIZA_MOCK_GOOGLE_BASE` at
  `eliza/plugins/plugin-google/src/client-factory.ts:20`, so the redirect
  helper sets that env var.
- Base URL (real): `https://gmail.googleapis.com`
- Mockoon URL: `http://localhost:18801` (set as `ELIZA_MOCK_GOOGLE_BASE`)
- Endpoints exercised by lifeops:
  - `GET /gmail/v1/users/{userId}/messages?q=...&maxResults=...`
  - `GET /gmail/v1/users/{userId}/messages/{id}?format=...`
  - `GET /gmail/v1/users/{userId}/threads?q=...`
  - `GET /gmail/v1/users/{userId}/threads/{id}`
  - `POST /gmail/v1/users/{userId}/drafts`
  - `POST /gmail/v1/users/{userId}/drafts/send`
  - `GET /gmail/v1/users/{userId}/labels`
  - `POST /gmail/v1/users/{userId}/messages/{id}/modify` (label add/remove)

### 2. calendar (port 18802, file `calendar.json`)

- Source: same plugin, `service-mixin-calendar.ts`,
  `service-normalize-calendar.ts`, the schedule sync writers.
- Same env var as Gmail — `ELIZA_MOCK_GOOGLE_BASE`. The Mockoon environment
  serves both prefixes (`/gmail/v1/...` and `/calendar/v3/...`) so a single
  port can stand in for the whole googleapis.com root, but we keep this as a
  separate environment for tests that want to point at calendar-only behaviour
  on a different port.
- Endpoints exercised:
  - `GET /calendar/v3/users/me/calendarList`
  - `GET /calendar/v3/calendars/{calendarId}/events?timeMin=...&timeMax=...`
  - `GET /calendar/v3/calendars/{calendarId}/events/{eventId}`
  - `POST /calendar/v3/calendars/{calendarId}/events`
  - `PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}`
  - `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}`

### 3. slack (port 18803, file `slack.json`)

- Source: `@elizaos/plugin-slack` (used by lifeops via the connector
  registry). No env-var override exists upstream today — the Mockoon redirect
  helper just provides the base URL; tests that exercise slack have to patch
  the plugin's WebClient base URL through the redirect helper export. See the
  follow-up note at the bottom of this file for the one-line patch needed.
- Base URL: `https://slack.com/api`
- Mockoon URL: `http://localhost:18803`
- Endpoints exercised:
  - `POST /chat.postMessage`
  - `GET /conversations.list`
  - `GET /conversations.history?channel=...`
  - `GET /users.list`
  - `POST /chat.update`
  - `POST /reactions.add`

### 4. discord (port 18804, file `discord.json`)

- Source: `@elizaos/plugin-discord` (REST via discord.js). The plugin reads
  `DISCORD_API_BASE` if present (passed into the underlying REST client). No
  override is wired in upstream today; we add `ELIZA_MOCK_DISCORD_BASE` to the
  redirect helper and it's the responsibility of any future test wiring to
  thread it into discord.js's REST client.
- Base URL: `https://discord.com/api/v10`
- Mockoon URL: `http://localhost:18804`
- Endpoints exercised:
  - `GET /users/@me/guilds`
  - `GET /guilds/{guildId}/channels`
  - `GET /channels/{channelId}/messages?limit=...`
  - `POST /channels/{channelId}/messages`

### 5. telegram (port 18805, file `telegram.json`)

- Source: `@elizaos/plugin-telegram` reads `TELEGRAM_API_BASE` constant in
  `setup-routes.ts:26`. The plugin uses Telegraf, which honours its own
  `apiRoot` option; the redirect helper exports `LIFEOPS_TELEGRAM_API_BASE`
  for any caller that wants to override Telegraf's base URL during tests.
- Base URL: `https://api.telegram.org`
- Mockoon URL: `http://localhost:18805`
- Endpoints exercised (token segment is `botTEST_BOT_TOKEN` in mock):
  - `POST /bot{token}/sendMessage`
  - `GET /bot{token}/getUpdates`
  - `GET /bot{token}/getMe`
  - `POST /bot{token}/sendChatAction`

### 6. github (port 18806, file `github.json`)

- Source: `@elizaos/plugin-github` uses Octokit. Octokit accepts a `baseUrl`
  option; tests need to thread `LIFEOPS_GITHUB_API_BASE` through that. Today
  there is no env var override — only the redirect helper export.
- Base URL: `https://api.github.com`
- Mockoon URL: `http://localhost:18806`
- Endpoints exercised:
  - `GET /search/issues?q=...`
  - `GET /repos/{owner}/{repo}/issues`
  - `GET /repos/{owner}/{repo}/pulls`
  - `GET /repos/{owner}/{repo}/commits`
  - `POST /repos/{owner}/{repo}/issues`

### 7. notion (port 18807, file `notion.json`)

- Source: There is no first-party `@elizaos/plugin-notion` checked in here;
  notion calls happen through the workspace-mirror skill at runtime. The mock
  is provided so a future plugin can validate against it.
- Base URL: `https://api.notion.com`
- Mockoon URL: `http://localhost:18807`
- Endpoints exercised (per Notion API v1):
  - `POST /v1/search`
  - `POST /v1/pages`
  - `PATCH /v1/blocks/{blockId}/children`
  - `GET /v1/databases/{databaseId}`

### 8. twilio (port 18808, file `twilio.json`)

- Source: `eliza/plugins/app-lifeops/src/lifeops/twilio.ts` — already supports
  `ELIZA_MOCK_TWILIO_BASE`. The redirect helper sets it to
  `http://localhost:18808` when `LIFEOPS_USE_MOCKOON=1`.
- Endpoints exercised:
  - `POST /2010-04-01/Accounts/{AccountSid}/Messages.json`
  - `POST /2010-04-01/Accounts/{AccountSid}/Calls.json`

### 9. plaid (port 18809, file `plaid.json`)

- Source: `eliza/plugins/app-lifeops/src/lifeops/plaid-managed-client.ts`. The
  client hits the local Eliza Cloud relay at
  `${apiBaseUrl}/v1/eliza/plaid/...`, NOT the public Plaid REST API directly.
  The redirect helper sets `ELIZAOS_CLOUD_BASE_URL` to
  `http://localhost:18809` when mockoon is active (note: this is shared with
  the eliza-cloud env on port 18816 in production tests; here we keep them
  separate so plaid-only tests do not need the rest of the cloud surface).
- Endpoints exercised:
  - `POST /v1/eliza/plaid/link-token`
  - `POST /v1/eliza/plaid/exchange`
  - `POST /v1/eliza/plaid/sync`

### 10. apple-reminders (port 18810, file `apple-reminders.json`)

- Source: `lifeops/apple-reminders.ts` calls a local bridge over HTTP. The
  base URL is the platform/OS bridge; tests today rely on a stub. The mock
  serves a minimal CRUD shape.
- Mockoon URL: `http://localhost:18810`
- Endpoints exercised:
  - `GET /reminders/lists`
  - `GET /reminders?listId=...`
  - `POST /reminders` (create)
  - `PATCH /reminders/{id}` (complete/update)

### 11. bluebubbles (port 18811, file `bluebubbles.json`)

- Source: `@elizaos/plugin-bluebubbles` connects to a local BlueBubbles server
  whose base URL the user configures (typically `http://localhost:1234`). The
  redirect helper exposes `LIFEOPS_BLUEBUBBLES_BASE` which test wiring threads
  into the plugin config.
- Endpoints exercised:
  - `GET /api/v1/chat`
  - `GET /api/v1/chat/{guid}/message`
  - `POST /api/v1/message/text`

### 12. ntfy (port 18812, file `ntfy.json`)

- Source: `eliza/plugins/app-lifeops/src/lifeops/notifications-push.ts` reads
  `NTFY_BASE_URL`. The redirect helper sets it to
  `http://localhost:18812`.
- Endpoints exercised:
  - `POST /{topic}` (publish)

### 13. duffel (port 18813, file `duffel.json`)

- Source: `eliza/plugins/app-lifeops/src/lifeops/travel-adapters/duffel.ts`.
  The `DUFFEL_API_BASE` is a `const`, but the resolver picks between cloud
  relay mode and direct mode. We add a one-line patch (see the wiring file)
  so direct mode honours `LIFEOPS_DUFFEL_API_BASE` from the redirect helper.
- Endpoints exercised:
  - `POST /air/offer_requests`
  - `GET /air/offers`
  - `POST /air/orders`

### 14. anthropic (port 18814, file `anthropic.json`)

- Source: `@anthropic-ai/sdk` reads `ANTHROPIC_BASE_URL`. Mock is for
  failure-injection only — happy path stays live or against Cerebras.
- Endpoints exercised (failure-only):
  - `POST /v1/messages` — returns 429 / 529 / 500 depending on toggle
  - `POST /v1/messages/count_tokens`

### 15. cerebras (port 18815, file `cerebras.json`)

- Source: Cerebras OpenAI-compatible endpoint via `OPENAI_BASE_URL`.
- Endpoints exercised:
  - `POST /v1/chat/completions` (deterministic responses keyed on the prompt
    contents through Mockoon rules)
  - `POST /v1/embeddings`

### 16. eliza-cloud (port 18816, file `eliza-cloud.json`)

- Source: `eliza/plugins/plugin-elizacloud` plus the lifeops managed clients
  (plaid, paypal, schedule-sync). All read `ELIZAOS_CLOUD_BASE_URL`. When
  `LIFEOPS_USE_MOCKOON=1` is set without the more specific plaid/paypal
  flags, the redirect helper points everything at this single env so the
  test runtime can stand up the entire cloud surface in one place.
- Endpoints exercised:
  - `POST /api/v1/eliza/auth/token`
  - `GET /api/v1/eliza/agents/me`
  - `GET /api/v1/eliza/billing/balance`
  - `POST /api/v1/eliza/plaid/link-token` (mirror of plaid env)
  - `POST /api/v1/eliza/paypal/authorize`
  - `POST /api/v1/eliza/schedule/sync`

### 17. spotify (port 18817, file `spotify.json`)

- Source: future plugin / subscription playbook references. Not currently
  wired into a runtime fetch; this mock exists so the planner trainer can
  exercise the surface without hitting the real API.
- Base URL: `https://api.spotify.com`
- Endpoints exercised:
  - `GET /v1/me`
  - `GET /v1/me/player/currently-playing`

### 18. signal (port 18818, file `signal.json`)

- Source: `eliza/plugins/app-lifeops/src/lifeops/signal-local-client.ts`
  reads `SIGNAL_HTTP_URL` (default `http://127.0.0.1:8080`). Redirect helper
  points it at `http://localhost:18818` when mockoon is active.
- Endpoints exercised:
  - `GET /v1/receive/{account}`
  - `POST /v2/send`

## Smoke test (verified)

These are the exact commands run on 2026-05-09 against the freshly-generated
environments. All four scenarios passed for both gmail (port 18801) and
calendar (port 18802):

```bash
# Direct binary path is fastest — `npm exec` / bunx adds 30+ seconds of
# resolution overhead before the port binds.
MOCKOON=/Users/$USER/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli
$MOCKOON start \
  --data eliza/test/mocks/mockoon/gmail.json --port 18801 \
  --disable-log-to-file &

# Happy path:
curl -s "http://localhost:18801/gmail/v1/users/me/messages?q=is:unread"
# -> { "messages": [ { "id": "193a1ed8c0aa1f01", ... }, ... ],
#      "resultSizeEstimate": 4, "nextPageToken": null }

# Fault toggles (header or query):
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Mockoon-Fault: rate_limit" \
  "http://localhost:18801/gmail/v1/users/me/messages?q=is:unread"
# -> 429

curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:18801/gmail/v1/users/me/messages?q=is:unread&_fault=auth_expired"
# -> 401

curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Mockoon-Fault: server_error" \
  "http://localhost:18801/gmail/v1/users/me/messages?q=is:unread"
# -> 500
```

To start them all in parallel use the orchestrator script:

```bash
# Default: looks for `mockoon-cli` on PATH (set MOCKOON_BIN to override).
# Set MOCKOON_USE_NPX=1 to fall back to `npx --yes @mockoon/cli@latest`.
node eliza/test/mocks/mockoon/start-all.mjs
# ...
node eliza/test/mocks/mockoon/stop-all.mjs
```

## Backlog / what's stubbed

These shipped as minimal-viable mocks — happy path only, sparse fixtures, no
failure variants beyond the standard 3:

- `discord.json` — message structure is minimal; threads/embeds are not modeled
- `notion.json` — only the most-used `search` + `pages.create` fixtures
- `apple-reminders.json` — bridge HTTP shape is approximated; the real bridge
  uses `bluebubbles`-style WebSockets in some configurations
- `bluebubbles.json` — chat list and message send only; attachments are not
  modeled
- `signal.json` — covers REST send/receive only; no group operations
- `spotify.json` — `me` and `currently-playing` only
- `anthropic.json` — failure-injection only by design (no happy path)

These connectors are NOT covered by an environment yet because they have no
direct lifeops fetch site (they go through the elizaos runtime model layer):

- OpenAI (use `cerebras.json` since both speak OpenAI-compatible chat
  completions)
- xAI / x.com — runtime model provider; no lifeops-side direct call
- WhatsApp (`@elizaos/plugin-whatsapp`) — uses the WhatsApp Cloud API; not
  exercised by current lifeops actions
- WeChat — local-only via `plugin-wechat`; not an external HTTP surface

If a new lifeops action starts hitting one of these, add an environment +
update the port table.

## Wiring summary (Phase 3)

`eliza/plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts`
exports a single `applyMockoonEnvOverrides()` function. The lifeops plugin
calls it at module load when `LIFEOPS_USE_MOCKOON=1`. The function sets:

- `ELIZA_MOCK_GOOGLE_BASE=http://localhost:18801` (gmail+calendar share root)
- `ELIZA_MOCK_TWILIO_BASE=http://localhost:18808`
- `NTFY_BASE_URL=http://localhost:18812`
- `ELIZAOS_CLOUD_BASE_URL=http://localhost:18816`
- `SIGNAL_HTTP_URL=http://localhost:18818`
- `LIFEOPS_DUFFEL_API_BASE=http://localhost:18813` (consumed by duffel.ts)

Plus exports for the connectors that have no env-var override yet (slack,
discord, telegram, github, notion, bluebubbles, apple-reminders, spotify,
anthropic, cerebras). Tests that exercise those connectors call
`getMockoonBaseUrl(connector)` directly.
