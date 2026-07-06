# @elizaos/plugin-bluebubbles

iMessage bridge for Eliza agents via the BlueBubbles macOS app and REST API.

## Purpose / role

Enables an Eliza agent to send and receive iMessages and SMS through a
[BlueBubbles](https://bluebubbles.app/) server running on a macOS host. The
plugin is **opt-in**: it auto-enables when `config.connectors.bluebubbles` is
present and not explicitly disabled. It registers no actions — all messaging
flows through the elizaOS message-connector framework.

## Plugin surface

### Services
- **`BlueBubblesService`** (`src/service.ts`) — core service. Connects to the
  BlueBubbles REST API on startup, caches known chats, registers a
  `bluebubbles` and `imessage` message-connector pair, and dispatches inbound
  webhook events into the agent's memory/message pipeline.
- **`BlueBubblesWorkflowCredentialProvider`** (`src/workflow-credential-provider.ts`)
  — supplies `httpQueryAuth` credentials (password + serverUrl) to
  `@elizaos/plugin-workflow` when BlueBubbles is used as a workflow HTTP
  target.

### Routes
All routes use `rawPath: true`.

**Setup-contract routes** (`src/setup-routes.ts`):
- `GET  /api/setup/bluebubbles/status` — service health + webhook path
- `POST /api/setup/bluebubbles/start`  — persist serverUrl + password, set enabled
- `POST /api/setup/bluebubbles/cancel` — wipe stored credentials

**Data routes** (`src/data-routes.ts`):
- `GET  /api/bluebubbles/chats`    — list chats via the BlueBubbles client
- `GET  /api/bluebubbles/messages` — list messages for a chat (`?chatGuid=`)
- `POST /webhooks/bluebubbles`     — inbound webhook receiver (requires `X-BlueBubbles-Webhook-Secret`)

### Message-connector capabilities
Registered on both `"bluebubbles"` and `"imessage"` sources:
`send_message`, `reply`, `reactions`, `effects`, `chat_context`

Supported target kinds: `phone`, `email`, `contact`, `user`, `group`, `room`

## Layout

```
src/
  index.ts                      Plugin definition and init/dispose
  service.ts                    BlueBubblesService — main service class
  client.ts                     BlueBubblesClient — REST API wrapper
  environment.ts                Config parsing from runtime settings
  accounts.ts                   Account resolution for default + named BlueBubbles servers
  connector-account-provider.ts ConnectorAccountManager provider
  workflow-credential-provider.ts Workflow credential bridge
  setup-routes.ts               Setup-contract HTTP routes
  data-routes.ts                Data + webhook HTTP routes
  webhook-auth.ts               X-BlueBubbles-Webhook-Secret validation
  constants.ts                  Service name, default paths, policy constants
  types.ts                      Domain types (BlueBubblesConfig, BlueBubblesMessage, BlueBubblesChat…)
  actions/index.ts              Empty — messaging uses connector hooks only
  providers/index.ts            Empty — context via connector getChatContext/getUserContext
auto-enable.ts                  Lightweight shouldEnable() for the plugin engine
```

## Commands

```bash
bun run --cwd plugins/plugin-bluebubbles build
bun run --cwd plugins/plugin-bluebubbles test
bun run --cwd plugins/plugin-bluebubbles lint
bun run --cwd plugins/plugin-bluebubbles lint:check
bun run --cwd plugins/plugin-bluebubbles format
bun run --cwd plugins/plugin-bluebubbles format:check
bun run --cwd plugins/plugin-bluebubbles typecheck
```

## Config / env vars

| Env var | Required | Default | Description |
|---|---|---|---|
| `BLUEBUBBLES_SERVER_URL` | yes* | — | BlueBubbles server base URL |
| `BLUEBUBBLES_PASSWORD` | yes | — | BlueBubbles server password |
| `BLUEBUBBLES_WEBHOOK_SECRET` | recommended | — | Shared secret validated on every POST to `/webhooks/bluebubbles` (header `X-BlueBubbles-Webhook-Secret`). Webhook requests are rejected without it. |
| `BLUEBUBBLES_WEBHOOK_PATH` | no | `/webhooks/bluebubbles` | Override inbound webhook path |
| `BLUEBUBBLES_DM_POLICY` | no | `pairing` | `open` \| `pairing` \| `allowlist` \| `disabled` |
| `BLUEBUBBLES_GROUP_POLICY` | no | `allowlist` | `open` \| `allowlist` \| `disabled` |
| `BLUEBUBBLES_ALLOW_FROM` | no | — | Comma-separated allowlist for DM senders |
| `BLUEBUBBLES_GROUP_ALLOW_FROM` | no | — | Comma-separated allowlist for group senders |
| `BLUEBUBBLES_SEND_READ_RECEIPTS` | no | `true` | Send read receipts on inbound messages |
| `BLUEBUBBLES_ENABLED` | no | `true` | Set to `false` to disable without removing config |
| `BLUEBUBBLES_AUTOSTART_COMMAND` | no | `open` (macOS only) | Command to launch BlueBubbles before connecting |
| `BLUEBUBBLES_AUTOSTART_ARGS` | no | `-a BlueBubbles` | Comma-separated or JSON array of args |
| `BLUEBUBBLES_AUTOSTART_CWD` | no | — | Working directory for auto-start command |
| `BLUEBUBBLES_AUTOSTART_WAIT_MS` | no | `15000` | Max ms to wait for BlueBubbles to become reachable |

*`BLUEBUBBLES_SERVER_URL` + `BLUEBUBBLES_PASSWORD` can also come from
`character.settings.bluebubbles.serverUrl` / `.password`, or from per-account
blocks under `character.settings.bluebubbles.accounts.<id>`.

## How to extend

### Add an action
1. Create `src/actions/my-action.ts` exporting an `Action` object.
2. Add it to the `actions: []` array in `src/index.ts`.
3. Export it from `src/index.ts` if callers need it.
   See the root `AGENTS.md` for action conventions.

### Add a provider
1. Create `src/providers/my-provider.ts` exporting a `Provider` object.
2. Add it to the `providers: []` array in `src/index.ts`.
3. If the provider needs the BlueBubbles client, fetch it from the service:
   `runtime.getService<BlueBubblesService>("bluebubbles")?.getClient()`.

### Add an HTTP route
1. Add a handler function and a `Route` entry in `src/data-routes.ts` or a
   new file.
2. Spread the new route array into the `routes: [...]` array in `src/index.ts`.
3. Use `rawPath: true` on all routes in this plugin.

## Conventions / gotchas

- **macOS only for receiving.** BlueBubbles runs exclusively on macOS.
  `BLUEBUBBLES_SERVER_URL` must point at a reachable BlueBubbles server.
  Auto-start defaults to `open -a BlueBubbles` and only fires on `darwin`.
- **Webhook secret is enforced.** Every POST to `/webhooks/bluebubbles` is
  rejected with 401 if `BLUEBUBBLES_WEBHOOK_SECRET` is not set. Configure it
  in both the BlueBubbles server app and the agent env.
- **Private API required for edit/unsend.** `BlueBubblesClient.editMessage()`
  and `.unsendMessage()` require the BlueBubbles Private API to be enabled.
  Check `probeResult.privateApiEnabled` before using those paths.
- **Chat GUIDs vs handles.** The client accepts either a BlueBubbles chat GUID
  (`iMessage;-;<handle>`, `iMessage;+;<group-id>`, `SMS;-;<phone>`) or a raw
  handle; `BlueBubblesClient.resolveTarget()` normalizes bare handles to
  `iMessage;-;<handle>`. Raw phone/email handles are normalized via
  `normalizeHandle()` in `src/environment.ts`.
- **No actions registered.** All send/receive flows go through the
  `registerSendHandler` / message-connector path, not plugin actions.
- **Accounts.** Multiple BlueBubbles server records can be configured via
  `character.settings.bluebubbles.accounts.<accountId>` and are exposed through
  the connector-account provider. A service instance connects to the resolved
  default account (`default` when configured, otherwise the first enabled named
  account); run separate agent instances for simultaneous independent servers.
- **Build.** Uses `build.ts` (tsc) via `bun run build.ts`. Output is ESM
  only (`"type": "module"`), entry `dist/index.js`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
