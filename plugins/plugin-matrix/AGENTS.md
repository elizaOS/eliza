# @elizaos/plugin-matrix

Matrix messaging connector for Eliza agents — connects agents to Matrix homeservers via `matrix-js-sdk`.

## Purpose / role

Adds Matrix protocol support to an Eliza agent: receive and send messages in Matrix rooms, manage room membership, send reactions, threading, typing indicators, and read receipts. Auto-enabled when a `matrix` connector block is present in the agent config (`config.connectors.matrix.enabled !== false`). Node.js only (see `eliza.platforms` in package.json).

## Plugin surface

The exported `matrixPlugin` object (`src/index.ts`) registers:

| Kind | Name | What it does |
|------|------|-------------|
| Service | `MatrixService` (`serviceType: "matrix"`) | Core Matrix client lifecycle: connects to homeserver, syncs rooms, dispatches incoming messages as events, exposes send/react/join/leave/typing/read-receipt API. Registers a `MessageConnector` with the runtime that wires `resolveTargets`, `listRecentTargets`, `listRooms`, `fetchMessages`, `searchMessages`, `reactHandler`, `joinHandler`, `leaveHandler`, `getChatContext`, `getUserContext`, and the `sendHandler`. |
| Service | `MatrixWorkflowCredentialProvider` (`serviceType: "workflow_credential_provider"`) | Supplies `matrixApi` credentials (`accessToken` + `homeserverUrl`) to the workflow plugin without adding a compile-time dep on it. |
| Actions | _(none registered)_ | Matrix send/react/join/leave surfaces are exposed via the `MessageConnector` registered by `MatrixService`, not through standalone actions. |
| Providers | _(none registered)_ | Room list is exposed through the connector's `MESSAGE list_channels` path; provider index is intentionally empty. |

On `init`, the plugin also registers a `ConnectorAccountProvider` with the `ConnectorAccountManager` (via `createMatrixConnectorAccountProvider`).

## Events emitted

Emitted on `runtime.emitEvent`:

| Event constant | Value | Trigger |
|----------------|-------|---------|
| `MatrixEventTypes.MESSAGE_RECEIVED` | `MATRIX_MESSAGE_RECEIVED` | Incoming `m.room.message` (text only; filtered by `requireMention` if set) |
| `MatrixEventTypes.MESSAGE_SENT` | `MATRIX_MESSAGE_SENT` | Message sent via `sendMessage` |
| `MatrixEventTypes.ROOM_JOINED` | `MATRIX_ROOM_JOINED` | `joinRoom` succeeds |
| `MatrixEventTypes.ROOM_LEFT` | `MATRIX_ROOM_LEFT` | `leaveRoom` succeeds |
| `MatrixEventTypes.SYNC_COMPLETE` | `MATRIX_SYNC_COMPLETE` | Matrix `PREPARED` sync state |

## Layout

```
plugins/plugin-matrix/
  auto-enable.ts                      Auto-enable check (loaded by elizaOS boot engine)
  src/
    index.ts                          Plugin definition — services list, init, dispose
    service.ts                        MatrixService — SDK client lifecycle, send/react/join/leave,
                                        MessageConnector registration, multi-account dispatch
    accounts.ts                       Multi-account config resolution (env vars + character settings
                                        + MATRIX_ACCOUNTS JSON); exports resolveMatrixAccountSettings,
                                        listMatrixAccountIds, normalizeMatrixAccountId, readMatrixAccountId
    connector-account-provider.ts     ConnectorAccountProvider adapter for ConnectorAccountManager
    workflow-credential-provider.ts   MatrixWorkflowCredentialProvider — duck-typed for plugin-workflow
    types.ts                          MatrixSettings, MatrixMessage, MatrixRoom, IMatrixService,
                                        MatrixEventTypes enum, error classes, utility functions
    providers/
      index.ts                        Empty; rooms exposed through MessageConnector, not providers
    __tests__/
      connector.test.ts               Connector integration tests
```

## Commands

All scripts are relative to the plugin root:

```bash
bun run --cwd plugins/plugin-matrix build         # Compile via build.ts → dist/
bun run --cwd plugins/plugin-matrix test          # vitest run
bun run --cwd plugins/plugin-matrix lint          # Biome check + fix
bun run --cwd plugins/plugin-matrix lint:check    # Biome check (read-only)
bun run --cwd plugins/plugin-matrix format        # Biome format + fix
bun run --cwd plugins/plugin-matrix format:check  # Biome format (read-only)
bun run --cwd plugins/plugin-matrix typecheck     # tsgo --noEmit
```

## Config / env vars

Settings are resolved in priority order: per-account object in `MATRIX_ACCOUNTS` JSON > `character.settings.matrix.<field>` > env var (env vars only apply to the `default` account).

| Env var | Required | Description |
|---------|----------|-------------|
| `MATRIX_ACCESS_TOKEN` | Yes | Access token for the Matrix bot account |
| `MATRIX_HOMESERVER` | Yes (validated at init) | Homeserver URL, e.g. `https://matrix.org` |
| `MATRIX_USER_ID` | Yes (validated at init) | Full Matrix user ID, e.g. `@bot:matrix.org` |
| `MATRIX_DEVICE_ID` | No | Device ID for this session (auto-assigned if absent) |
| `MATRIX_ROOMS` | No | Comma-separated room IDs / aliases to auto-join on start |
| `MATRIX_AUTO_JOIN` | No (`false`) | Auto-accept room invites |
| `MATRIX_ENCRYPTION` | No (`false`) | Enable E2EE (requires SDK support) |
| `MATRIX_REQUIRE_MENTION` | No (`false`) | Only process messages that mention the bot |
| `MATRIX_ACCOUNTS` | No | JSON array/object of per-account configs for multi-account setups |
| `MATRIX_DEFAULT_ACCOUNT_ID` | No | Which account is the default when multiple are configured |
| `MATRIX_ACCOUNT_ID` | No | Alias for `MATRIX_DEFAULT_ACCOUNT_ID` |

Character-level config (`character.settings.matrix`) accepts the same fields as `MatrixSettings` (see `src/types.ts`). Multi-account: set `character.settings.matrix.accounts` as a keyed object, or supply `MATRIX_ACCOUNTS` as a JSON array with an `accountId`/`id` field per entry.

## How to extend

**Add a new action:**
1. Create `src/actions/<name>.ts` exporting an `Action` conforming to `@elizaos/core`.
2. Import and push it into the `actions: []` array in `src/index.ts`.

**Add a new provider:**
1. Create `src/providers/<name>.ts` exporting a `Provider`.
2. Import and push into the `providers: []` array in `src/index.ts`.

**Add a new event handler:**
Inside `MatrixService.setupEventHandlers` in `src/service.ts`, call `state.client.on(...)` for the desired Matrix SDK event, then emit via `this.runtime.emitEvent(MatrixEventTypes.<NAME>, payload)`. Add the new event constant to the `MatrixEventTypes` enum in `src/types.ts`.

**Add a second Matrix account:**
Supply `MATRIX_ACCOUNTS='[{"accountId":"work","homeserver":"...","userId":"...","accessToken":"..."}]'` or add an `accounts` key to `character.settings.matrix`. `MatrixService.initialize` iterates `listMatrixAccountIds` and creates a separate SDK client + MessageConnector registration per account.

## Conventions / gotchas

- **Node.js only.** `matrix-js-sdk` is a Node.js package; this plugin will not work in browser or mobile runtimes.
- **Auto-enable module is imported at boot before full plugin init.** Keep `auto-enable.ts` free of transitive imports from `src/`.
- **No actions array.** Matrix send/react/join/leave are exposed via the runtime's `MessageConnector` abstraction, not via `Plugin.actions`. Other plugins invoke Matrix through the connector system (`source: "matrix"`).
- **E2EE flag exists but relies on SDK-level support.** Setting `MATRIX_ENCRYPTION=true` flags the intent; the SDK must also have appropriate crypto support enabled in the deployment.
- **Message splitting is the caller's responsibility.** `MAX_MATRIX_MESSAGE_LENGTH = 4000` (exported from `types.ts`) — the service does not auto-split; callers must chunk before calling `sendMessage`.
- **`providers/index.ts` is intentionally empty.** Room context is surfaced by the `MessageConnector` hooks (`getChatContext`, `listRooms`), not by a runtime provider.
- **`MatrixWorkflowCredentialProvider` duck-types the workflow contract.** It does not import `@elizaos/plugin-workflow` to avoid a circular dep; the runtime matches by `serviceType` string only.
