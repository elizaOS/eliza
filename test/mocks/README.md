# LifeOps External API Mocks

This directory contains Mockoon-compatible environment files that emulate the
external HTTP APIs LifeOps integrates with. Tests serve these files through the
in-process fixture runner in `scripts/start-mocks.ts` and point LifeOps clients
at those local URLs via env vars instead of hitting real services.

## Files

| File                              | Mocks                                | Env var                     |
| --------------------------------- | ------------------------------------ | --------------------------- |
| `environments/twilio.json`        | Twilio Programmable Messaging/Voice  | `ELIZA_MOCK_TWILIO_BASE`   |
| `environments/whatsapp.json`      | WhatsApp Business Cloud (Meta Graph) | `ELIZA_MOCK_WHATSAPP_BASE` |
| `environments/calendly.json`      | Calendly v2                          | `ELIZA_MOCK_CALENDLY_BASE` |
| `environments/x-twitter.json`     | X (Twitter) v2                       | `ELIZA_MOCK_X_BASE`        |
| `environments/google.json`        | Gmail / Calendar / OAuth token       | `ELIZA_MOCK_GOOGLE_BASE`   |
| `environments/cloud-managed.json` | Eliza Cloud managed-Google endpoints | `ELIZA_CLOUD_BASE_URL`      |
| `environments/signal.json`        | signal-cli HTTP receive/send         | `SIGNAL_HTTP_URL`           |
| `environments/browser-workspace.json` | Desktop browser workspace bridge | `ELIZA_BROWSER_WORKSPACE_URL` |
| `environments/bluebubbles.json`   | BlueBubbles iMessage HTTP API        | `ELIZA_BLUEBUBBLES_URL`     |
| `environments/github.json`        | GitHub REST plus Octokit fixtures    | `ELIZA_MOCK_GITHUB_BASE`   |

Each LifeOps client reads its env var on import and falls back to the real URL
when unset. These env vars are test-only: the normal `bun run dev` launcher now
strips inherited `ELIZA_MOCK_*` values so local development keeps using real
Google/Twilio/etc. unless you opt back in explicitly. See the patched files in
`eliza/apps/app-lifeops/src/lifeops/`:

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
  --data test/mocks/environments/github.json
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
export ELIZA_IMESSAGE_BACKEND=bluebubbles
export ELIZA_BLUEBUBBLES_URL=http://127.0.0.1:3008
export ELIZA_BLUEBUBBLES_PASSWORD=mock-bluebubbles-password
export ELIZA_MOCK_GITHUB_BASE=http://127.0.0.1:3009
```

## Test usage

Tests use `createMockedTestRuntime`, which boots the fixture servers, isolates
Eliza state/config in a temporary directory, sets the mock env vars, and then
constructs the LifeOps runtime. Existing unit tests that use
`vi.stubGlobal('fetch', ...)` continue to work and do not require fixture
servers.

## Google / Gmail mock coverage

`environments/google.json` is the local Gmail/Google fixture used by
`ELIZA_MOCK_GOOGLE_BASE`. The in-process runner also adds Gmail-specific
dynamic routes for surfaces LifeOps needs for read, send, and inbox-zero
development:

- message list/get/send/modify plus batch modify/delete
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

## Provider coverage and remaining gaps

The executable source of truth for this table is
`helpers/provider-coverage.ts`; `provider-coverage-contract.test.ts` fails when
a required LifeOps provider, mock environment, validation file, or documented gap
falls out of sync.

| Provider id | Covered surfaces | Remaining gaps |
| --- | --- | --- |
| `google-calendar` | OAuth token/userinfo rewrite; calendar list; event list/get/search; event create/patch/update/move/delete; request ledger metadata | No recurring-event expansion beyond single synthetic events<br>No freebusy, ACL, attachment, or conference-data surfaces<br>No Google rate-limit or partial-failure variants |
| `gmail` | work/home account fixture data; message list/get/search/send/modify/delete; thread list/get/modify/trash/untrash; draft create/list/get/send/delete; labels, history, watch, filters; priority, vague, multi-search, and cross-account query fixtures; write request ledger metadata | Search is deterministic fixture matching, not the full Gmail query grammar<br>No attachment download/upload or multipart MIME fidelity<br>No delegated mailbox, push-notification, quota, or rate-limit variants |
| `github` | REST pull request list/review; issue creation and assignment fixtures; issue/PR search; notification list; Octokit-shaped unit-test fixture; request ledger metadata | No GraphQL API coverage<br>No checks, statuses, contents, branch protection, or workflow endpoints<br>No webhook delivery simulation |
| `x` | home timeline; mentions; recent search; DM list; tweet create; DM send; request ledger metadata | No streaming API, OAuth handshake, media upload, or delete/like/repost surfaces<br>No rate-limit, partial response, or protected-account variants |
| `whatsapp` | text message send; inbound webhook ingestion; test-only inbound buffer route; request ledger metadata | No media upload/download, templates, reactions, or message status lifecycle<br>No webhook signature validation or delivery retry simulation |
| `telegram` | MTProto local-client dependency injection; auth retry state; connector service status; send/search/read-receipt calls through mocked client deps | No central HTTP mock because LifeOps does not consume Telegram through HTTP<br>No MTProto protocol simulator, media fixture, or group-admin fixture |
| `signal` | signal-cli health check; REST receive; REST send; JSON-RPC send; request ledger metadata | No attachment, group-management, profile, registration, or safety-number surfaces<br>No daemon restart, backfill, or malformed-envelope variants |
| `discord` | desktop browser workspace tab lifecycle; navigation; script evaluation; snapshot; request ledger metadata | No Discord REST or Gateway mock<br>DOM fixture cannot prove Discord production layout compatibility<br>No attachment, reaction, edit, or thread lifecycle coverage |
| `imessage-bluebubbles` | server info; chat query; message query/search; text send; message detail/delivery metadata; request ledger metadata | No attachment, tapback/reaction, edit, unsend, or read-receipt lifecycle<br>No macOS Messages database fallback fixture in the central mock runner |
| `twilio` | Programmable Messaging send; Programmable Voice call create; Mockoon template request echo | No delivery status callbacks, recordings, media, incoming call webhooks, or error variants |
| `calendly` | current user; event types; available times; scheduling links; scheduled events | No webhooks, invitee cancellation/reschedule, organization/team scope, or OAuth refresh variants |
| `eliza-cloud-managed-google` | managed Google status; managed Google account list | No managed mutation routes, cloud auth failure matrix, billing limits, or account relink flows |

## Add or edit mocks

Open the JSON files directly, or use the [Mockoon desktop
app](https://mockoon.com/download/) (it loads the same JSON format).
The full Mockoon templating syntax is documented at
https://mockoon.com/docs/latest/templating/overview/.
