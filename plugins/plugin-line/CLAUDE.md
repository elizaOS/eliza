# @elizaos/plugin-line

LINE Messaging API connector for elizaOS agents.

## Purpose / role

Connects an Eliza agent to the [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/), enabling the agent to receive webhook events and send text, flex/card, location, template, and quick-reply messages to LINE users, groups, and rooms. The plugin is opt-in: add `@elizaos/plugin-line` to the agent's `plugins` array and supply `LINE_CHANNEL_ACCESS_TOKEN` plus `LINE_CHANNEL_SECRET`. It registers a LINE message connector with the elizaOS `ConnectorAccountManager` so the generic `MESSAGE` action routes outbound messages through LINE automatically.

## Plugin surface

The plugin object (`linePlugin`, default export from `src/index.ts`) registers:

| Kind | Name | What it does |
|------|------|--------------|
| Service | `LineService` (`serviceType = "line"`) | Core LINE client: sends push/reply messages, handles incoming webhook events, registers the LINE connector with the runtime's message connector system. |
| Service | `LineWorkflowCredentialProvider` (`serviceType = "workflow_credential_provider"`) | Supplies the LINE channel access token to the workflow plugin as an `httpHeaderAuth` credential (`Authorization: Bearer <token>`). |
| Actions | _(none)_ | Outbound messaging routes through the core `MESSAGE` action via the registered connector. |
| Providers | _(none)_ | Chat and user context come from core `PLATFORM_*` providers via connector hooks. |
| Evaluators | _(none)_ | — |

Events emitted by `LineService` (use `runtime.emitEvent`/`runtime.on`):

| Event key | Trigger |
|-----------|---------|
| `line:connection_ready` | Service successfully initialised with a valid token |
| `line:message_received` | Inbound webhook text/image/sticker/etc. event |
| `line:message_sent` | Outbound push message delivered |
| `line:follow` | User followed the bot |
| `line:unfollow` | User unfollowed |
| `line:join_group` | Bot added to a group/room |
| `line:leave_group` | Bot removed from a group/room |
| `line:postback` | Postback action triggered |

All event string constants live in `src/types.ts` as `LineEventTypes`.

## Layout

```
src/
  index.ts                     Plugin entry — assembles Plugin object, runs init, registers connector provider
  service.ts                   LineService: LINE client, send/reply methods, webhook event dispatch, connector hooks
  workflow-credential-provider.ts  LineWorkflowCredentialProvider: supplies Bearer token to workflow plugin
  connector-account-provider.ts   createLineConnectorAccountProvider() — adapts multi-account config to ConnectorAccountManager
  accounts.ts                  Multi-account config helpers: resolveLineAccount(), listEnabledLineAccounts(), etc.
  messaging.ts                 Text processing utilities: chunk, strip markdown, format tables/code/links
  types.ts                     All LINE types, constants (LINE_SERVICE_NAME, LineEventTypes, MAX_LINE_BATCH_SIZE), error classes
  actions/index.ts             Empty — routing goes through MESSAGE connector
  providers/index.ts           Empty — context comes from core PLATFORM_* providers
```

## Commands

Only scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-line build          # compile via build.ts (bunx tsc)
bun run --cwd plugins/plugin-line test           # vitest run
bun run --cwd plugins/plugin-line test:watch     # vitest watch
bun run --cwd plugins/plugin-line lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-line lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-line format         # biome format --write
bun run --cwd plugins/plugin-line format:check   # biome format (read-only)
bun run --cwd plugins/plugin-line typecheck      # tsgo --noEmit
```

## Config / env vars

Read via `runtime.getSetting(key)` with `process.env` fallback. Priority: runtime setting > env var > default.

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | — | Long-lived channel access token from LINE Developers Console |
| `LINE_CHANNEL_SECRET` | Yes (for webhook verification) | — | Channel secret for HMAC signature validation |
| `LINE_WEBHOOK_PATH` | No | `/webhooks/line` | Webhook route path |
| `LINE_DM_POLICY` | No | `pairing` | DM access: `open` / `pairing` / `allowlist` / `disabled` |
| `LINE_GROUP_POLICY` | No | `allowlist` | Group access: `open` / `allowlist` / `disabled` |
| `LINE_ALLOW_FROM` | No | — | Comma-separated LINE user IDs for allowlist policy |
| `LINE_ENABLED` | No | `true` | Set to `false` to disable the service without removing the plugin |

Multi-account config can also be provided via `character.settings.line` (see `LineMultiAccountConfig` in `src/accounts.ts`) with per-account overrides under `.accounts.<id>`.

## How to extend

**Add an action** (e.g., a LINE-specific command):

1. Create `src/actions/my-action.ts` exporting an `Action` object.
2. Import and add it to the `actions: []` array in `src/index.ts`.

**Add a provider** (e.g., expose LINE group membership):

1. Create `src/providers/my-provider.ts` exporting a `Provider` object.
2. Import and add it to the `providers: []` array in `src/index.ts`.

**Handle a new webhook event type** (e.g., `beacon`):

1. Add a new key to `LineEventTypes` in `src/types.ts`.
2. Add a `case "beacon":` branch in `LineService.handleWebhookEvent()` in `src/service.ts`.

**Add a new message type to the send path**:

1. Add a field to `LineChannelData` in `src/types.ts`.
2. Handle the new field in `LineService.sendConnectorContent()` in `src/service.ts`.

## Conventions / gotchas

- **No HTTP server.** This plugin does not bind a webhook endpoint itself. The caller (e.g., the agent HTTP server) must mount an Express/Hono route that calls `lineService.createMiddleware()` for signature verification and `lineService.handleWebhookEvents(events)` to dispatch.
- **LINE ID prefixes.** User IDs start with `U`, group IDs with `C`, room IDs with `R`. `getChatTypeFromId()` in `src/types.ts` and `normalizeLineTarget()` rely on these prefixes. Wrong IDs silently fall through as `"user"` type.
- **Push vs reply.** `sendMessage()` / `sendFlexMessage()` / etc. use the push API (requires a messaging-enabled plan). `replyMessage()` uses the reply token from a webhook event (free tier works, but the token expires quickly).
- **Batch limit.** The LINE API accepts at most 5 messages per push call (`MAX_LINE_BATCH_SIZE = 5`). `sendMessage()` splits long text automatically via `splitMessageForLine()`.
- **`@line/bot-sdk` v11.** Types are namespaced under `messagingApi.*` and `webhook.*`. Import from the namespaces, not the package root.
- **`LINE_CHANNEL_SECRET` is required.** `validateSettings()` throws if either `LINE_CHANNEL_ACCESS_TOKEN` or `LINE_CHANNEL_SECRET` is absent. Both must be set for the service to start.
- **`LINE_ENABLED=false`** stops the service cleanly without throwing; useful for disabling LINE in a shared character file.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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
