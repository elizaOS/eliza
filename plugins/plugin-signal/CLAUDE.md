# @elizaos/plugin-signal

Signal messaging integration — lets an Eliza agent send and receive end-to-end-encrypted Signal messages via signal-cli or its REST API.

## Purpose / role

Adds a `signal` message connector so Eliza agents can send DMs and group messages on Signal, receive inbound messages as runtime memories, emit typed Signal events, and surface Signal contacts and groups as conversation targets. The plugin is opt-in: it auto-enables when a `signal` block is present under `config.connectors` and not explicitly disabled.

## Plugin surface

### Services
- **`SignalService`** (`serviceType: "signal"`) — core connector. Starts a signal-cli daemon (or connects to an existing HTTP API), registers a `MessageConnector` with the runtime, polls/streams inbound messages, stores them as memories, and emits `SignalEventTypes` events. Also exposes `sendMessage`, `sendGroupMessage`, `sendReaction`, and `getRecentMessages` for programmatic use.
- **`SignalWorkflowCredentialProvider`** (`serviceType: "workflow_credential_provider"`) — supplies `httpHeaderAuth` credentials (account number + HTTP URL) to the workflow plugin for Signal-backed automations.

### Actions
None registered. Sending is done via the `MessageConnector` send handler or direct `SignalService` method calls.

### Providers
None registered. Connector targets (contacts, groups, recent messages) are resolved through the `MessageConnector.resolveTargets` / `listRecentTargets` / `listRooms` hooks.

### Evaluators
None.

### Routes (mounted at raw paths, no plugin-name prefix)
- `GET  /api/setup/signal/status` — pairing/connection state for an account (`?accountId=<id>`).
- `POST /api/setup/signal/start`  — begin a QR device-linking session (signal-cli `link`).
- `POST /api/setup/signal/cancel` — stop pairing in progress and wipe auth on disk.

### Events emitted
| Constant | String value | When |
|---|---|---|
| `SignalEventTypes.MESSAGE_RECEIVED` | `SIGNAL_MESSAGE_RECEIVED` | inbound message stored |
| `SignalEventTypes.MESSAGE_SENT` | `SIGNAL_MESSAGE_SENT` | outbound message recorded |
| `SignalEventTypes.REACTION_RECEIVED` | `SIGNAL_REACTION_RECEIVED` | inbound reaction |
| `SignalEventTypes.GROUP_JOINED` | `SIGNAL_GROUP_JOINED` | group join event |
| `SignalEventTypes.GROUP_LEFT` | `SIGNAL_GROUP_LEFT` | group leave event |

## Layout

```
src/
  index.ts                      Plugin object; init/dispose; all public exports
  service.ts                    SignalService (core connector, daemon lifecycle, message I/O)
  types.ts                      All interfaces/enums/errors/constants (SignalMessage, SignalContact, etc.)
  signal-native.d.ts            Type shim for optional @elizaos/signal-native peer dep
  accounts.ts                   Multi-account resolution; merges env + character settings
  config.ts                     SignalConfig / SignalActionConfig / SignalReactionLevel types
  rpc.ts                        HTTP client to signal-cli REST API (signalSend, signalRpcRequest, SSE stream)
  local-client.ts               SignalLocalClientConfig + low-level HTTP helpers used by SignalService; publicly exported
  pairing-service.ts            SignalPairingSession — QR device linking via signal-cli or @elizaos/signal-native
  setup-routes.ts               HTTP route handlers for /api/setup/signal/* and QR override helper
  connector-account-provider.ts ConnectorAccountManager provider (list/create/patch/delete accounts)
  workflow-credential-provider.ts Workflow plugin credential bridge (httpHeaderAuth)
auto-enable.ts                  Auto-enable check (loaded by plugin engine at boot; no heavy imports)
```

## Commands

```bash
bun run --cwd plugins/plugin-signal build        # compile with build.ts → dist/
bun run --cwd plugins/plugin-signal dev          # hot-reload build
bun run --cwd plugins/plugin-signal test         # vitest run
bun run --cwd plugins/plugin-signal clean        # rm -rf dist .turbo
bun run --cwd plugins/plugin-signal format       # biome format --write
bun run --cwd plugins/plugin-signal format:check # biome format (check only)
```

## Config / env vars

All resolved by `accounts.ts` `mergeSignalAccountConfig`. Env vars are the lowest-priority defaults; character `settings.signal` overrides them; per-account `settings.signal.accounts.<id>` overrides base.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `SIGNAL_ACCOUNT_NUMBER` | **yes** | — | Phone number in E.164 (e.g. `+15551234567`) |
| `SIGNAL_HTTP_URL` | no | `http://127.0.0.1:8080` | External signal-cli REST API URL; if omitted, the service auto-starts a daemon |
| `SIGNAL_CLI_PATH` | no | `signal-cli` (PATH) | Path to signal-cli binary; Homebrew auto-install on macOS/Linux unless `SIGNAL_CLI_AUTO_INSTALL=false` |
| `SIGNAL_CLI_AUTO_INSTALL` | no | `true` | Set `false` to disable Homebrew auto-install |
| `SIGNAL_AUTH_DIR` | no | `~/.local/share/signal-cli` | signal-cli data directory (matches signal-cli default) |
| `SIGNAL_STARTUP_TIMEOUT_MS` | no | `30000` | Max wait for daemon to become ready (capped at 120 000) |
| `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` | no | `false` | If `true`, agent ignores all group messages |
| `SIGNAL_AUTO_REPLY` | no | `false` | If `true`, agent auto-generates replies (off by default; use LifeOps sends instead) |
| `SIGNAL_RECEIVE_MODE` | no | `manual` | `on-start` = poll/stream immediately on init; `manual` = LifeOps pulls |
| `ELIZA_SIGNAL_CLI_AUTO_INSTALL` | no | — | Alias for `SIGNAL_CLI_AUTO_INSTALL` checked in pairing-service |

Character-level multi-account config lives under `character.settings.signal` (`SignalMultiAccountConfig`) with per-account overrides under `.accounts.<id>` (`SignalAccountConfig`).

## How to extend

### Add a new Signal action
1. Create `src/actions/my-action.ts` implementing `Action` from `@elizaos/core`.
2. Add it to the `actions` array in `src/index.ts` plugin object.
3. Call `runtime.getService<SignalService>(SignalService.serviceType)` inside the handler to send messages.

### Add a new provider
1. Create `src/providers/my-provider.ts` implementing `Provider`.
2. Add it to `providers` in `src/index.ts`.

### Add a new service
1. Extend `Service` from `@elizaos/core`, set a unique `static serviceType`.
2. Implement `static async start(runtime)` and `stop()`.
3. Add to `services` in `src/index.ts`.

## Conventions / gotchas

- **Two transport modes:** HTTP API (point `SIGNAL_HTTP_URL` at a running signal-cli daemon) or local CLI (plugin spawns signal-cli itself via `signal-cli daemon --http`). The service detects which mode to use based on whether a daemon is already reachable.
- **signal-cli Java dependency:** local CLI mode requires signal-cli on PATH and Java. On macOS, the service prepends Homebrew's OpenJDK to `PATH` and `JAVA_HOME` automatically (`/opt/homebrew/opt/openjdk`).
- **Optional native peer:** `@elizaos/signal-native` is a peer dep for QR device linking without spawning signal-cli. It is optional; pairing falls back to `signal-cli link` subprocess.
- **Auth directory:** defaults to `~/.local/share/signal-cli` (signal-cli's hardcoded XDG path on all platforms including macOS — it does not use `Library/Application Support`). Override with `SIGNAL_AUTH_DIR`.
- **Auto-reply is off by default.** Inbound messages are persisted as memories and emit `SIGNAL_MESSAGE_RECEIVED`, but the agent does not respond unless `SIGNAL_AUTO_REPLY=true`. Sends are expected to come from LifeOps or explicit caller actions.
- **Multi-account:** configure multiple phone numbers under `character.settings.signal.accounts`. Each account gets its own `SignalApiClient`, event stream, and connector registration.
- **Message size:** messages exceeding `MAX_SIGNAL_MESSAGE_LENGTH` (4 000 chars) are split automatically before dispatch.
- **Account IDs:** always normalized to lowercase via `normalizeAccountId`. The sentinel value `"default"` is used when no explicit ID is configured.
- **No actions registered:** the plugin deliberately registers zero actions. Sending is done via the `MessageConnector` or direct service calls — not via natural-language action dispatch.

See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM/naming standards.
