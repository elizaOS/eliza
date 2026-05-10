# LifeOps External API Mocks

This directory contains Mockoon-compatible environment files that emulate the
external HTTP APIs LifeOps integrates with. Tests serve these files through the
in-process fixture runner in `scripts/start-mocks.ts` and point LifeOps clients
at those local URLs via env vars instead of hitting real services.

## Files

| File                                  | Mocks                                | Env var                                                  |
| ------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `environments/twilio.json`            | Twilio Programmable Messaging/Voice  | `ELIZA_MOCK_TWILIO_BASE`                                |
| `environments/whatsapp.json`          | WhatsApp Business Cloud (Meta Graph) | `ELIZA_MOCK_WHATSAPP_BASE`                              |
| `environments/calendly.json`          | Calendly v2                          | `ELIZA_MOCK_CALENDLY_BASE`                              |
| `environments/x-twitter.json`         | X (Twitter) v2                       | `ELIZA_MOCK_X_BASE`                                     |
| `environments/google.json`            | Gmail / Calendar / OAuth token       | `ELIZA_MOCK_GOOGLE_BASE`                                |
| `environments/cloud-managed.json`     | Eliza Cloud managed-Google endpoints | `ELIZA_CLOUD_BASE_URL`                                   |
| `environments/signal.json`            | signal-cli HTTP receive/send         | `SIGNAL_HTTP_URL`                                        |
| `environments/browser-workspace.json` | Desktop browser workspace bridge     | `ELIZA_BROWSER_WORKSPACE_URL` / `ELIZA_BROWSER_WORKSPACE_TOKEN` / `ELIZA_DISABLE_DISCORD_DESKTOP_CDP` |
| `environments/bluebubbles.json`       | BlueBubbles iMessage HTTP API        | `ELIZA_BLUEBUBBLES_URL`                                  |
| `environments/github.json`            | GitHub REST plus Octokit fixtures    | `ELIZA_MOCK_GITHUB_BASE`                                 |
| `environments/discord.json`           | Discord REST API v10                 | `ELIZA_MOCK_DISCORD_BASE`                                |
| `environments/slack.json`             | Slack Web API                        | `ELIZA_MOCK_SLACK_BASE`                                  |
| `environments/telegram.json`          | Telegram Bot API (HTTP)              | `ELIZA_MOCK_TELEGRAM_BASE`                               |
| `environments/linear.json`            | Linear GraphQL API                   | `ELIZA_MOCK_LINEAR_BASE`                                 |
| `environments/shopify.json`           | Shopify Admin API 2024-04            | `ELIZA_MOCK_SHOPIFY_BASE`                                |
| `environments/payments.json`          | Payment requests and callbacks       | `ELIZA_MOCK_PAYMENT_BASE` / `ELIZA_MOCK_PAYMENTS_BASE`  |
| `environments/anthropic.json`         | Anthropic Messages API               | `ELIZA_MOCK_ANTHROPIC_BASE`                              |
| `environments/openai.json`            | OpenAI Chat / Embeddings / Models    | `ELIZA_MOCK_OPENAI_BASE`                                 |
| `environments/vision.json`            | Hosted vision analysis API           | `ELIZA_MOCK_VISION_BASE`                                 |

Each LifeOps client reads its env var on import and falls back to the real URL
when unset. These env vars are test-only: the normal `bun run dev` launcher now
strips inherited `ELIZA_MOCK_*` values so local development keeps using real
Google/Twilio/etc. unless you opt back in explicitly. See the patched files in
`eliza/plugins/app-lifeops/src/lifeops/`:

- `twilio.ts`, `whatsapp-client.ts`, `calendly-client.ts`
- `x-poster.ts`, `x-reader.ts`
- `google-fetch.ts` (rewrites all `*.googleapis.com` + `accounts.google.com`)
- `google-oauth.ts` (token + userinfo go through the same rewrite helper)

## Run mocks in tests

```ts
import { startMocks } from "./scripts/start-mocks.ts";

const mocks = await startMocks({ envs: ["google", "twilio"] });
process.env.ELIZA_MOCK_GOOGLE_BASE = mocks.baseUrls.google;
process.env.ELIZA_MOCK_TWILIO_BASE = mocks.baseUrls.twilio;
await mocks.stop();
```

Use the dedicated test helpers or test commands for this. Do not export
`ELIZA_MOCK_GOOGLE_BASE` in your regular shell before running `bun run dev`
unless you are intentionally debugging the mock path.

## Clean up a polluted dev profile

If the chat sidebar already shows old synthetic Google Calendar rows from a
past mock run:

1. Start the app normally with `bun run dev` so the dev launcher strips any
   leaked `ELIZA_MOCK_*` vars.
2. In the app, disconnect the Google LifeOps connector once.
3. Reconnect Google so LifeOps clears the cached mock rows and resyncs from the
   real account.

The Google disconnect flow already clears cached calendar events, Gmail cache,
and sync state for the disconnected connector.

Ports are auto-assigned on `127.0.0.1`. The fixture runner supports the subset
of Mockoon templating used by these files: `{{body 'field'}}`,
`{{urlParam 'id'}}`, `{{faker '...'}}`, and `{{now '...'}}`.

## Run with Mockoon manually

Mockoon is optional for editing or manual inspection of the same JSON files.

```bash
bunx @mockoon/cli start --data test/mocks/environments/twilio.json
# ... or all HTTP fixture files in parallel:
bunx @mockoon/cli start \
  --data test/mocks/environments/twilio.json \
  --data test/mocks/environments/whatsapp.json \
  --data test/mocks/environments/calendly.json \
  --data test/mocks/environments/x-twitter.json \
  --data test/mocks/environments/google.json \
  --data test/mocks/environments/cloud-managed.json \
  --data test/mocks/environments/signal.json \
  --data test/mocks/environments/browser-workspace.json \
  --data test/mocks/environments/bluebubbles.json \
  --data test/mocks/environments/github.json \
  --data test/mocks/environments/payments.json \
  --data test/mocks/environments/lifeops-presence-active.json
```

Then point the clients at the mocks:

```bash
export ELIZA_MOCK_TWILIO_BASE=http://127.0.0.1:3001
export ELIZA_MOCK_WHATSAPP_BASE=http://127.0.0.1:3002
export ELIZA_MOCK_CALENDLY_BASE=http://127.0.0.1:3003
export ELIZA_MOCK_X_BASE=http://127.0.0.1:3004
export ELIZA_MOCK_GOOGLE_BASE=http://127.0.0.1:3005
export SIGNAL_HTTP_URL=http://127.0.0.1:3006
export SIGNAL_ACCOUNT_NUMBER=+15550000000
export ELIZA_BROWSER_WORKSPACE_URL=http://127.0.0.1:3007
export ELIZA_BROWSER_WORKSPACE_TOKEN=mock-browser-workspace-token
export ELIZA_DISABLE_DISCORD_DESKTOP_CDP=1
export ELIZA_IMESSAGE_BACKEND=bluebubbles
export ELIZA_BLUEBUBBLES_URL=http://127.0.0.1:3008
export ELIZA_BLUEBUBBLES_PASSWORD=mock-bluebubbles-password
export ELIZA_MOCK_GITHUB_BASE=http://127.0.0.1:3009
export ELIZA_MOCK_PAYMENT_BASE=http://127.0.0.1:3010
export ELIZA_MOCK_PAYMENTS_BASE=http://127.0.0.1:3010
export ELIZA_MOCK_LIFEOPS_PRESENCE_ACTIVE_BASE=http://127.0.0.1:3011
```

## Test usage

Tests use `createMockedTestRuntime`, which boots the fixture servers, isolates
elizaOS state/config in a temporary directory, sets the mock env vars, and then
constructs the LifeOps runtime. Existing unit tests that use
`vi.stubGlobal('fetch', ...)` continue to work and do not require fixture
servers.

## Full LifeOps simulator

For end-to-end LifeOps coverage, opt into the richer simulator dataset:

```ts
const mocked = await createMockedTestRuntime({
  seedLifeOpsSimulator: true,
});
```

This keeps the connector code on the same API seams as production while seeding
a synthetic owner, mock people, cross-channel inbound data, reminders,
calendar items, and outbound-capable mocks for Gmail, Calendar, Telegram,
Signal, Discord, WhatsApp, and iMessage. The simulator is opt-in so low-level
provider contract tests can keep their small exact fixtures.

Live account comparison must be read-only by default. Use:

```bash
bunx tsx scripts/lifeops-readonly-connector-snapshot.ts \
  --base-url=http://127.0.0.1:31337 \
  --out=artifacts/lifeops-live-snapshot.json
```

The snapshot script only sends `GET` requests, redacts emails/phone numbers and
long IDs, and skips Signal message pulls unless
`--include-destructive-pulls` is explicitly passed because signal-cli receive
can consume its queue.

## Google / Gmail mock coverage

`environments/google.json` is the local Gmail/Google fixture used by
`ELIZA_MOCK_GOOGLE_BASE`. The in-process runner also adds Gmail-specific
dynamic routes for surfaces LifeOps needs for read, send, and inbox-zero
development:

- message list/get/send/modify plus batch modify/delete
- message attachment metadata and download
- message trash, untrash, and delete
- label list, including system labels and the `eliza-e2e` user label
- draft create/list/get/send/delete
- thread list/get/modify/trash/untrash
- watch and history list
- settings filter creation for unsubscribe/archive flows

This fixture is intentionally deterministic and synthetic. It is not a full
Gmail search engine: the in-process runner matches method plus path, while query
parameters, auth scopes, request-body validation, pagination, and rate-limit
variants need a stateful Gmail fixture service or a richer runner layer. Keep
real mailbox captures out of this directory unless they have gone through a
redaction and fixture-validation pipeline.

## Non-Google dynamic mock coverage

The in-process runner adds stateful contract routes for these provider files:

- X read/search/DM surfaces: `/2/dm_events`, home timeline, mentions, recent
  search, tweet create, and DM send.
- WhatsApp send plus inbound webhook ingestion at `/webhook` and
  `/webhooks/whatsapp`; the buffered webhook messages are visible through the
  test-only `/__mock/whatsapp/inbound` route.
- Signal local HTTP receive/send: `/api/v1/check`, `/api/v1/rpc`,
  `/v1/receive/:account`, and `/v2/send`.
- Discord browser workspace bridge routes: `/tabs`, `/tabs/:id/navigate`,
  `/tabs/:id/eval`, `/tabs/:id/show`, `/tabs/:id/hide`,
  `/tabs/:id/snapshot`, and tab close.
- BlueBubbles iMessage routes: server info, chat query, message query/search,
  message send, chat messages, and message detail.
- GitHub REST fixtures for PR list/review, issue create/assign, search, and
  notifications. `helpers/github-octokit-fixture.ts` also exports a reusable
  Octokit-shaped fixture for plugin unit tests.

Telegram is intentionally not represented as an HTTP mock here. LifeOps uses
MTProto through `telegram-local-client.ts` and already exposes a dependency
injection seam (`TelegramLocalClientDeps`) for tests. Adding a fake Telegram
HTTP gateway would not match a real consumer path.

## Presence-active interaction scenario mocks

`fixtures/lifeops-presence-active.ts` is the executable catalog for the seven assistant
interaction moves from the Samantha/Theodore setup and email scene: intake
affect, assistant identity, permissioned context scan, bulk email curation,
contact resolution, document review, and proactive multi-hop follow-up.

The in-process runner serves the catalog only from the `lifeops-presence-active` mock
base URL:

- `GET /__mock/lifeops/presence-active/scenarios` returns scenario summaries, provider
  coverage, API example counts, and edge-case counts.
- `GET /__mock/lifeops/presence-active/scenarios/:id` returns the full scenario with
  lined-up mock records, API examples, expected workflow, assertions, safety
  gates, and edge cases.
- `POST /__mock/lifeops/presence-active/tasks` starts a synthetic long-running task for
  the multi-hop vendor packet scenario.
- `GET /__mock/lifeops/presence-active/tasks/:id` returns the current deterministic
  task snapshot without advancing it.
- `POST /__mock/lifeops/presence-active/tasks/:id/advance` moves the in-process task
  through queued, running, waiting-for-input, and completed snapshots.

For manual Mockoon API testing, load
`test/mocks/environments/lifeops-presence-active.json`. It exposes representative local
LifeOps endpoints for onboarding affect, organization scans, email curation,
explicit preference memory, contact resolution, document proofread,
long-running task polling, task advance, and edge variants for provider
downtime, ambiguous recipients, too-broad bulk email requests, and rate limits.
The standalone Mockoon file is stateless; full task progression is provided by
the in-process `startMocks` runner. Provider API examples are static contract
checks against the provider mocks above, so complex tests can combine the
scenario catalog with Gmail, GitHub, Signal, BlueBubbles, and browser-workspace
requests.

## Provider coverage and remaining gaps

The executable source of truth for this table is
`helpers/provider-coverage.ts`; `provider-coverage-contract.test.ts` fails when
a required LifeOps provider, mock environment, validation file, or documented gap
falls out of sync.

| Provider id                  | Covered surfaces                                                                                                                                                                                                                                                                     | Remaining gaps                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-calendar`            | OAuth token and userinfo rewrite; calendar list; event list/get/search; event create/patch/update/move/delete; request ledger metadata                                                                                                                                               | No recurring-event expansion beyond single synthetic events<br>No freebusy, ACL, attachment, or conference-data surfaces<br>No Google rate-limit or partial-failure variants                                     |
| `gmail`                      | work/home account fixture data; message list/get/search/send/modify/delete; thread list/get/modify/trash/untrash; draft create/list/get/send/delete; attachment metadata and download; labels, history, watch, filters; priority, vague, multi-search, and cross-account query fixtures; write request ledger metadata | Search is deterministic fixture matching, not the full Gmail query grammar<br>No attachment upload or full multipart MIME fidelity<br>No delegated mailbox, push-notification, quota, or rate-limit variants |
| `github`                     | REST pull request list/review; issue creation and assignment fixtures; issue/PR search; notification list; Octokit-shaped unit-test fixture; request ledger metadata                                                                                                                 | No GraphQL API coverage<br>No checks, statuses, contents, branch protection, or workflow endpoints<br>No webhook delivery simulation                                                                             |
| `x`                          | home timeline; mentions; recent search; DM list; tweet create; DM send; request ledger metadata                                                                                                                                                                                      | No streaming API, OAuth handshake, media upload, or delete/like/repost surfaces<br>No rate-limit, partial response, or protected-account variants                                                                |
| `whatsapp`                   | text message send; inbound webhook ingestion; Cloud API webhook metadata and contact mapping in simulator seed; test-only inbound buffer route; request ledger metadata                                                                                                             | No media upload/download, templates, reactions, or message status lifecycle<br>No webhook signature validation or delivery retry simulation                                                                      |
| `telegram`                   | MTProto local-client dependency injection; encoded local mock session for full LifeOps simulator runs; auth retry state; connector service status; send/search/read-receipt calls through mocked client deps                                                                         | No central HTTP mock because LifeOps does not consume Telegram through HTTP<br>No MTProto protocol simulator, media fixture, or group-admin fixture                                                              |
| `signal`                     | signal-cli health check; REST receive; REST send; JSON-RPC send; connected service read path backed by signal-cli receive in simulator runs; request ledger metadata                                                                                                                | No attachment, group-management, profile, registration, or safety-number surfaces<br>No daemon restart, backfill, or malformed-envelope variants                                                                 |
| `discord`                    | desktop browser workspace tab lifecycle; navigation; script evaluation; LifeOps outbound send handler through browser workspace eval; snapshot; request ledger metadata                                                                                                             | No Discord REST or Gateway mock<br>DOM fixture cannot prove Discord production layout compatibility<br>No attachment, reaction, edit, or thread lifecycle coverage                                               |
| `imessage-bluebubbles`       | server info; chat query; message query/search; text send; message detail/delivery metadata; request ledger metadata                                                                                                                                                                  | No attachment, tapback/reaction, edit, unsend, or read-receipt lifecycle<br>No macOS Messages database fallback fixture in the central mock runner                                                               |
| `twilio`                     | Programmable Messaging send; Programmable Voice call create; Mockoon template request echo                                                                                                                                                                                           | No delivery status callbacks, recordings, media, incoming call webhooks, or error variants                                                                                                                       |
| `calendly`                   | current user; event types; available times; scheduling links; scheduled events                                                                                                                                                                                                       | No webhooks, invitee cancellation/reschedule, organization/team scope, or OAuth refresh variants                                                                                                                 |
| `eliza-cloud-managed-google` | managed Google status; managed Google account list                                                                                                                                                                                                                                   | No managed mutation routes, cloud auth failure matrix, billing limits, or account relink flows                                                                                                                   |
| `discord-rest`               | POST message to channel (stateful message store); GET channel messages (merged sent + inbound history); GET single message in channel; GET channel info; GET guild info; GET guild channels; GET guild member; GET /users/@me (bot identity); GET /applications/@me; POST interaction callback (204); GET gateway/bot; Test-only peek at /__mock/discord/sent; Test-only inject at /__mock/discord/inbound | No Discord Gateway / WebSocket mock; No voice channel, thread, forum, or stage surfaces; No attachment upload, reaction, edit, or delete endpoints; No rate-limit, retry-after, or permission-error variants |
| `slack`                      | POST chat.postMessage (stateful per-channel); chat.update; chat.delete; GET conversations.list (derived from sent-message channels); GET conversations.history; GET users.info; GET users.list; POST auth.test (bot identity); POST oauth.v2.access (token exchange); POST files.upload; POST /events (URL verification challenge echo); Test-only peek at /__mock/slack/sent; Test-only inject at /__mock/slack/inbound (also /__mock/slack/inbound-event alias) | No Events API signing verification; No Block Kit interactive components; No real file content storage; files.upload returns metadata only; No RTM or Socket Mode                                                                                                                                                                                    |
| `telegram-bot-http`          | `GET /bot<token>/getMe`; `POST /bot<token>/sendMessage`; `POST /bot<token>/sendPhoto`; `POST /bot<token>/editMessageText`; `POST /bot<token>/sendChatAction`; `GET /bot<token>/getFile`; `POST /bot<token>/answerCallbackQuery`; `GET /bot<token>/getUpdates (drains pending queue)`; `POST /bot<token>/setWebhook`; `POST /bot<token>/deleteWebhook`; `POST /bot<token>/answerInlineQuery`; Test-only inject at /__mock/telegram/inbound (also /__mock/telegram/inbound-update alias) | No MTProto; only Bot API HTTP surface; No media types beyond photo (audio, video, document, sticker); No inline keyboards or reply markup payload validation; No chat/group admin endpoints |
| `linear`                     | POST /graphql — Viewer query; POST /graphql — Issues query; POST /graphql — Teams query; POST /graphql — Team query; POST /graphql — Users query; POST /graphql — Projects query; POST /graphql — IssueCreate mutation (stateful issue store); POST /graphql — IssueUpdate mutation; POST /graphql — IssueDelete mutation | No webhook delivery simulation; No full GraphQL grammar (fragments, aliases, pagination cursors); No attachment, comment, cycle, or roadmap surfaces; No rate-limit or permission-error variants |
| `shopify`                    | GET /admin/api/2024-10/products.json; POST /admin/api/2024-10/products.json; GET /admin/api/2024-10/products/:id.json; GET /admin/api/2024-10/orders.json; GET /admin/api/2024-10/orders/:id.json; GET /admin/api/2024-10/customers.json; GET /admin/api/2024-10/customers/:id.json; GET /admin/api/2024-10/inventory_levels.json; GET /admin/api/2024-10/shop.json | No cart, checkout, or fulfillment surfaces; No webhook delivery or signature verification; No metafields, collections, discounts, or gift cards; No pagination, filter query params, or error variants |
| `payments`                   | POST /v1/payment-requests — create a dollar-denominated payment request; GET /v1/payment-requests/:id — status lookup; POST /v1/payment-requests/:id/pay — mark paid/accepted with transaction hash; POST /v1/payment-requests/:id/fail — mark failed and attach a reason; POST /api/v1/apps/:appId/charges — Cloud-style app charge request; GET /api/v1/apps/:appId/charges/:chargeId — public charge status; POST /api/v1/apps/:appId/charges/:chargeId/checkout — mock Stripe/OxaPay checkout link; GET /__mock/payments/requests — inspect payment request, app charge, and callback ledger; DELETE /__mock/payments/requests and POST /__mock/payments/reset — reset state; Signed HTTP callbacks for paid and failed transitions; request ledger metadata | No card-network, wallet, OxaPay, Stripe, or x402 protocol validation; No real settlement, exchange-rate, dispute, refund, or chargeback lifecycle; No delayed webhook retries; callback delivery is synchronous in the fixture |
| `anthropic`                  | POST /v1/messages — text response (static baseline); POST /v1/messages — prompt-prefix-keyed text response (ping/echo/summarize/explain); POST /v1/messages — tool_use response (when tools present); POST /v1/messages — computer-use tool_use (screenshot first turn); POST /v1/messages — text after tool_result (computer-use follow-up); GET /v1/models | No streaming (Server-Sent Events) support; No message batches API; No Files API or vision image uploads; No prompt caching or token-budget headers                                                                                        |
| `openai`                     | POST /v1/chat/completions; POST /v1/embeddings (deterministic 1536-dim vector seeded by sha256 of input); POST /v1/images/generations (placeholder image URL); GET /v1/models | No streaming (Server-Sent Events) support; No vision image uploads or image-in-content; No function-calling streaming or parallel tool calls; No Assistants v2 (threads, runs, vector stores); No fine-tuning, moderation, or audio endpoints |
| `vision-analysis`            | POST /v1/vision/analyze — cat-fixture (default; legacy path); POST /v1/analyze — full analyze; sha256 image-bytes hash → fixture, fallback to image_hint, fallback to generic; POST /v1/describe — caption only; POST /v1/objects — object detection only; POST /v1/text — OCR only; Three deterministic fixture hints: cat-fixture, document-fixture, street-fixture; Generic 'no recognizable content' response for unknown image hashes | No real computer vision; responses are deterministic fixture data; No OCR confidence scores or word-level bounding boxes; No multi-image batch analysis; No streaming or async result polling                                              |

## Add or edit mocks

Open the JSON files directly, or use the [Mockoon desktop
app](https://mockoon.com/download/) (it loads the same JSON format).
The full Mockoon templating syntax is documented at
https://mockoon.com/docs/latest/templating/overview/.
