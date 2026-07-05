# @elizaos/plugin-slack

Slack integration for elizaOS agents: connects via Slack Socket Mode, handles inbound events, and registers a full-featured message connector.

## Purpose / role

Gives an Eliza agent a live Slack presence. The plugin starts `SlackService` (a `@slack/bolt` Socket Mode connection) and registers it as a `MessageConnector` with the elizaOS runtime, enabling the agent to send, receive, search, react to, edit, delete, and pin messages across channels, threads, and DMs.

Loaded via `@elizaos/plugin-slack`. Auto-enabled when `config.connectors.slack` is present and not explicitly set to `enabled: false`. Also auto-enabled via the fallback `connectorKeys: ["slack"]` in the plugin manifest.

## Plugin surface

**Services** (registered in `services: [...]`):

- `SlackService` — Socket Mode connection manager. Handles one or more Slack workspace accounts (multi-account). Registers the message connector and all send/receive/mutation handlers with the runtime. Service type: `"slack"` (`SLACK_SERVICE_NAME`).
- `SlackWorkflowCredentialProvider` — Duck-typed `workflow_credential_provider` service. Supplies `slackApi` (bot token `xoxb-`) and `slackOAuth2Api` (user token `xoxp-`) credentials to the workflow plugin without a compile-time dependency.

**Actions:** none (the plugin registers no discrete actions; Slack messaging is handled via the core `MessageConnector` interface).

**Providers:** none declared in the plugin manifest. Context is surfaced through the message connector (`chat_context`, `user_context` capabilities).

**Events emitted** (`SlackEventTypes` enum in `src/types.ts`):

| Constant | String key |
|---|---|
| `MESSAGE_RECEIVED` | `SLACK_MESSAGE_RECEIVED` |
| `MESSAGE_SENT` | `SLACK_MESSAGE_SENT` |
| `REACTION_ADDED` | `SLACK_REACTION_ADDED` |
| `REACTION_REMOVED` | `SLACK_REACTION_REMOVED` |
| `CHANNEL_JOINED` | `SLACK_CHANNEL_JOINED` |
| `CHANNEL_LEFT` | `SLACK_CHANNEL_LEFT` |
| `MEMBER_JOINED_CHANNEL` | `SLACK_MEMBER_JOINED_CHANNEL` |
| `MEMBER_LEFT_CHANNEL` | `SLACK_MEMBER_LEFT_CHANNEL` |
| `APP_MENTION` | `SLACK_APP_MENTION` |
| `SLASH_COMMAND` | `SLACK_SLASH_COMMAND` |
| `FILE_SHARED` | `SLACK_FILE_SHARED` |
| `THREAD_REPLY` | `SLACK_THREAD_REPLY` |

**Message connector capabilities:** `send_message`, `read_messages`, `search_messages`, `resolve_targets`, `list_rooms`, `list_servers`, `chat_context`, `user_context`, `react_message`, `edit_message`, `delete_message`, `pin_message`, `get_user`.

**Connector account management:** on `init`, the plugin registers a `ConnectorAccountProvider` with the `ConnectorAccountManager`, exposing HTTP CRUD and OAuth v2 install flows for Slack workspaces.

## Layout

```
plugins/plugin-slack/
  auto-enable.ts                 Auto-enable gate (env reads only, no service init)
  src/
    index.ts                     Plugin object, init(), dispose(), public exports
    service.ts                   SlackService — Socket Mode, event handlers, connector registration, message send/receive, account management
    types.ts                     All exported types, interfaces, enums, error classes, constants (SLACK_SERVICE_NAME, MAX_SLACK_MESSAGE_LENGTH, etc.)
    accounts.ts                  Multi-account config types (SlackAccountConfig, SlackMultiAccountConfig, etc.) and resolution helpers (resolveSlackAccount, listEnabledSlackAccounts, etc.)
    config.ts                    Character-settings config shape types (SlackConfig, SlackThreadConfig)
    connector-account-provider.ts  ConnectorAccountManager bridge — lists, creates, patches, deletes accounts; OAuth v2 flow
    connector-credential-refs.ts   Persists connector credential references
    workflow-credential-provider.ts  SlackWorkflowCredentialProvider service
    formatting.ts                Slack mrkdwn formatting utilities (markdownToSlackMrkdwn, chunkSlackText, escapeSlackMrkdwn, etc.)
    accounts.test.ts             Unit tests for account helpers
    connector-account-provider.test.ts
    messageConnector.test.ts
```

## Commands

Only scripts defined in `package.json`. Run from the plugin dir or with `--cwd`:

```bash
bun run --cwd plugins/plugin-slack build        # compile with build.ts (bun build + tsc declarations)
bun run --cwd plugins/plugin-slack dev          # hot-reload build
bun run --cwd plugins/plugin-slack test         # vitest run
bun run --cwd plugins/plugin-slack typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-slack lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-slack lint:check   # biome check (no write)
bun run --cwd plugins/plugin-slack format       # biome format --write
bun run --cwd plugins/plugin-slack clean        # rm dist .turbo
```

## Config / env vars

Resolved via `runtime.getSetting(...)`. Single-account flat env vars or structured `character.settings.slack` (see `src/config.ts` `SlackConfig`).

| Env var | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot token, must start `xoxb-`. Service refuses to start without it. |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode, must start `xapp-`. |
| `SLACK_SIGNING_SECRET` | No | Passed to Bolt if set; needed for HTTP mode request verification. |
| `SLACK_USER_TOKEN` | No | User token `xoxp-` for `OWNER`-role accounts; used for `chat:write` as user. |
| `SLACK_ACCOUNT_ROLE` | No | Role for the default account. `"OWNER"` routes outbound messages through the user token; `"AGENT"` (default) uses the bot token. Applies only to the single-account (flat env) path. |
| `SLACK_CHANNEL_IDS` | No | Comma-separated channel IDs (`C…`, `G…`, `D…`) to restrict inbound messages. |
| `SLACK_SHOULD_IGNORE_BOT_MESSAGES` | No | `"true"` to suppress messages from other bots. Default: `false`. |
| `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No | `"true"` to require `@mention` before responding. Default: `false`. |

Multi-account config: set `character.settings.slack.accounts` as a record keyed by account ID. Each account supports the full `SlackAccountConfig` shape from `src/accounts.ts`.

## How to extend

**Add a new event handler in SlackService:**
1. Open `src/service.ts`, locate `registerEventHandlers(state)`.
2. Call `app.event("your_event_type", ...)` inside that method.
3. Emit the corresponding `SlackEventTypes` value via `this.runtime.emitEvent(...)`.
4. Add the new event type to the `SlackEventTypes` enum in `src/types.ts`.

**Add a new connector capability:**
1. Add the capability string to `SLACK_CONNECTOR_CAPABILITIES` in `src/service.ts`.
2. Implement the handler method on `SlackService`.
3. Wire it into the `ExtendedMessageConnectorRegistration` object in `registerSendHandlers`.

**Add a formatting utility:**
1. Add the export to `src/formatting.ts`.
2. Re-export from `src/index.ts`.

## Conventions / gotchas

- **Socket Mode only** in the default path. HTTP mode (`mode: "socket" | "http"` in `SlackAccountConfig`) is configured but the signing-secret HTTP receiver requires the app to be reachable from the internet; Socket Mode requires only `xapp-`.
- **Multi-account:** `SlackService` holds a `Map<string, SlackAccountRuntime>`. Each account gets its own `App` instance, event handlers, caches, and registered connector. The default account is the first in the map.
- **OWNER vs AGENT role:** OWNER-role accounts with a `userToken` route outbound `chat.postMessage` calls through `SlackWebClient(userToken)` so the bot posts as the user. AGENT-role (default) always uses the bot client.
- **Token format enforcement:** `init()` warns (but does not reject) if tokens do not match expected prefixes (`xoxb-`, `xapp-`, `xoxp-`).
- **Channel restriction:** `SLACK_CHANNEL_IDS` builds a static allowlist; channels the bot joins at runtime are tracked in `dynamicChannelIds`. Inbound messages outside both sets are silently dropped.
- **Mention deduplication:** `handleMessage` skips messages containing a `<@botUserId>` mention in non-DM channels — those are handled exclusively by `handleAppMention` to avoid double-processing.
- **No direct Bolt HTTP server:** the plugin does not expose any HTTP routes. All traffic flows through the Socket Mode WebSocket managed by `@slack/bolt`.
- **External deps:** `@slack/bolt ^4.1.0`, `@slack/web-api ^7.15.2`. Both are runtime dependencies, not dev-only.

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
