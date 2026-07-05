# @elizaos/plugin-twitch

Twitch chat integration for elizaOS agents — real-time IRC-based messaging via @twurple.

## Purpose / Role

Adds Twitch chat participation to an Eliza agent: connects to one or more channels, receives messages (with role-based filtering and optional @mention gating), and sends replies. Loaded as an opt-in plugin; auto-enabled when a `twitch` connector block is present in agent config and not explicitly disabled. No actions or providers are registered — all Twitch send/join/leave operations route through the runtime `MESSAGE` action via a registered `MessageConnector`.

## Plugin Surface

**Services** (registered in `plugin.services`):

- `TwitchService` — connects to Twitch IRC via @twurple/chat, joins channels, emits runtime events for every inbound message, and registers a `MessageConnector` with the runtime for outbound messaging. Supports multi-account mode via `TWITCH_ACCOUNTS` JSON.
- `TwitchWorkflowCredentialProvider` — satisfies `workflow_credential_provider` duck-type contract; supplies `httpHeaderAuth` Bearer credentials to the workflow plugin engine without adding a compile-time dep on `@elizaos/plugin-workflow`.

**Actions:** none registered by this plugin directly.

**Providers:** none registered by this plugin directly.

**Events emitted** (string constants in `TwitchEventTypes`):

| Event constant | String value | When fired |
|---|---|---|
| `MESSAGE_RECEIVED` | `TWITCH_MESSAGE_RECEIVED` | Inbound message passes filters |
| `MESSAGE_SENT` | `TWITCH_MESSAGE_SENT` | Message successfully sent |
| `JOIN_CHANNEL` | `TWITCH_JOIN_CHANNEL` | Bot joins a channel |
| `LEAVE_CHANNEL` | `TWITCH_LEAVE_CHANNEL` | Bot leaves a channel |
| `CONNECTION_READY` | `TWITCH_CONNECTION_READY` | IRC connected |
| `CONNECTION_LOST` | `TWITCH_CONNECTION_LOST` | IRC disconnected |

**MessageConnector capabilities** (registered per account):
`send_message`, `resolve_targets`, `list_rooms`, `join`, `leave`, `chat_context`

## Layout

```
plugins/plugin-twitch/
  src/
    index.ts                      Plugin entry — assembles Plugin object, runs init logging
    service.ts                    TwitchService — IRC lifecycle, event handling, connector handlers
    accounts.ts                   Multi-account config resolution (env vars + character.settings.twitch)
    connector-account-provider.ts ConnectorAccountProvider adapter for ConnectorAccountManager
    workflow-credential-provider.ts TwitchWorkflowCredentialProvider service
    types.ts                      All interfaces, enums, constants, utility fns, custom error classes
  auto-enable.ts                  Lightweight shouldEnable() — loaded by auto-enable engine at boot
  __tests__/
    integration.test.ts           Integration tests
  build.ts                        Build script (Bun)
  package.json
```

## Commands

```bash
bun run --cwd plugins/plugin-twitch build        # compile dist/
bun run --cwd plugins/plugin-twitch test         # run bun test
bun run --cwd plugins/plugin-twitch format       # biome format --write
bun run --cwd plugins/plugin-twitch format:check # biome format (check only)
```

## Config / Env Vars

Settings are resolved in priority order: per-account object in `TWITCH_ACCOUNTS` JSON > `character.settings.twitch` > top-level env vars (default account only). See `src/accounts.ts:resolveTwitchAccountSettings`.

| Env var | Required | Notes |
|---|---|---|
| `TWITCH_ACCESS_TOKEN` | **Yes** | OAuth token; `oauth:` prefix stripped automatically |
| `TWITCH_USERNAME` | **Yes** | Bot's Twitch login name |
| `TWITCH_CLIENT_ID` | **Yes** | Twitch application client ID |
| `TWITCH_CHANNEL` | **Yes** | Primary channel to join (no `#` prefix) |
| `TWITCH_CLIENT_SECRET` | No | Enables `RefreshingAuthProvider` (checked alone; `TWITCH_REFRESH_TOKEN` is optional alongside it); without it a `StaticAuthProvider` is used |
| `TWITCH_REFRESH_TOKEN` | No | Passed to `RefreshingAuthProvider` when `TWITCH_CLIENT_SECRET` is also set |
| `TWITCH_CHANNELS` | No | Comma-separated additional channels to join at startup |
| `TWITCH_REQUIRE_MENTION` | No | `"true"` — only process messages that @mention the bot username |
| `TWITCH_ALLOWED_ROLES` | No | Comma-separated: `all` (default), `owner`, `moderator`, `vip`, `subscriber` |
| `TWITCH_ACCOUNTS` | No | JSON array/object for multi-account mode; see `src/accounts.ts` |
| `TWITCH_ACCOUNT_ID` / `TWITCH_DEFAULT_ACCOUNT_ID` | No | Select default account when multiple are configured |

**Character settings alternative:** put a `twitch` object under `character.settings.twitch` with the same camelCase field names (`username`, `clientId`, `accessToken`, `channel`, `additionalChannels`, `requireMention`, `allowedRoles`, `allowedUserIds`). A nested `accounts` map supports multi-account within character config.

## How to Extend

**Add an action:** create `src/actions/my-action.ts` implementing `Action` from `@elizaos/core`, then add it to the `actions` array in `src/index.ts`. The plugin currently registers none.

**Add a provider:** same pattern — implement `Provider`, add to `providers` array in `src/index.ts`.

**Add an event handler:** subscribe to `TwitchEventTypes.MESSAGE_RECEIVED` via `runtime.registerEvent(...)` (or a plugin `events` map) in any action, service, or plugin init — the payload emitted by `TwitchService` is `{ runtime, accountId, message: TwitchMessage }`.

**Add a new channel at runtime:** call `twitchService.joinChannel(channelName)` directly after obtaining the service via `runtime.getService<TwitchService>(TWITCH_SERVICE_NAME)`.

## Conventions / Gotchas

- **No actions registered** — send/join/leave all go through the `MessageConnector` registered by `TwitchService.registerSendHandlers`. Do not add Twitch-specific action duplicates for these.
- **Channel names are normalized** — stored and compared without `#` prefix (`normalizeChannel` in `src/types.ts`). Pass channel names without `#` to all public methods.
- **Message chunking** — messages over 500 chars are split at sentence/word boundaries with a 300 ms delay between chunks (`splitMessageForTwitch` in `src/types.ts`).
- **Markdown stripping** — `stripMarkdownForTwitch` converts LLM output markdown to plain text before sending. Twitch does not render markdown.
- **`oauth:` prefix** — access tokens with `oauth:` prefix are silently stripped by `normalizeToken`; both forms are accepted.
- **Auth providers** — `RefreshingAuthProvider` activates when `TWITCH_CLIENT_SECRET` is set (regardless of whether `TWITCH_REFRESH_TOKEN` is present); otherwise falls back to `StaticAuthProvider` (no auto-refresh).
- **`auto-enable.ts` must stay lightweight** — it is imported by the auto-enable engine for every plugin at boot. No service initialization or heavy imports.
- **Node-only** — declared `"runtime": "node"` in package.json; not compatible with browser or mobile runtimes.
- **`TwitchWorkflowCredentialProvider` is duck-typed** — it satisfies the `workflow_credential_provider` service contract by string match only; it does not import `@elizaos/plugin-workflow` at compile time.

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
