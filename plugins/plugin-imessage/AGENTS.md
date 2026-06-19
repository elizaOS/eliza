# @elizaos/plugin-imessage

iMessage connector for Eliza agents on macOS — inbound polling via chat.db and outbound sending via AppleScript or a CLI tool.

## Purpose / role

Adds iMessage send/receive capability to an Eliza agent running on macOS. The plugin registers `IMessageService`, which polls `~/Library/Messages/chat.db` for inbound messages and delivers outbound messages through `osascript` (Messages.app) or an optional iMessage CLI tool. It also registers the service as a `MessageConnector` so the standard `MESSAGE` operation routes through it. Auto-enabled when `config.connectors.imessage` is present and not explicitly disabled; opt-in otherwise.

## Plugin surface

**Services**
- `IMessageService` (`src/service.ts`) — core service; polls chat.db, dispatches inbound messages through `runtime.messageService.handleMessage`, sends via AppleScript or CLI, registers the `MessageConnector` with `resolveTargets`, `listRecentTargets`, `listRooms`, `fetchMessages`, `searchMessages`, `getChatContext`, `getUserContext`. Static `serviceType = "imessage"`.

**Actions** — none registered. Sending goes through the `MessageConnector` path (`MESSAGE` / `operation=send`).

**Providers** — none registered as standalone elizaOS providers. Contact and chat context is surfaced through the `MessageConnector` hooks above.

**Routes** (all `rawPath: true`, no plugin-name prefix):

*Setup routes* (`src/setup-routes.ts`):
- `GET  /api/setup/imessage/status` — service health, chat.db availability, permission action
- `POST /api/setup/imessage/start` — mark imessage connector enabled in config
- `POST /api/setup/imessage/cancel` — remove imessage connector block from config

*Data routes* (`src/data-routes.ts`):
- `GET    /api/imessage/messages` — recent messages (`?chatId=&limit=`)
- `POST   /api/imessage/messages` — send a message (`{ to|chatId, text, mediaUrl? }`)
- `GET    /api/imessage/chats` — list chats (DMs + groups) from chat.db
- `GET    /api/imessage/contacts` — list Apple Contacts (full detail)
- `POST   /api/imessage/contacts` — create a contact (CNContactStore)
- `PATCH  /api/imessage/contacts/:id` — update a contact
- `DELETE /api/imessage/contacts/:id` — delete a contact

*Legacy HTTP handler exports* (`src/api/imessage-routes.ts`, `src/api/bluebubbles-routes.ts`):
- `handleIMessageRoute` / `handleBlueBubblesRoute` — raw `http.IncomingMessage` handlers for the agent's legacy HTTP router; not re-registered as `Route[]`.

**Events emitted** (`src/types.ts` — `IMessageEventTypes`):
- `IMESSAGE_CONNECTION_READY`, `IMESSAGE_MESSAGE_RECEIVED`, `IMESSAGE_MESSAGE_SENT`, `IMESSAGE_REACTION_RECEIVED`, `IMESSAGE_SYSTEM_EVENT`, `IMESSAGE_ERROR`
- Also emits core `EventType.MESSAGE_RECEIVED`, `MESSAGE_SENT`, `WORLD_JOINED`, `ENTITY_JOINED`.

## Layout

```
plugins/plugin-imessage/
  src/
    index.ts                    Plugin object; re-exports all public APIs
    service.ts                  IMessageService — polling, send, MessageConnector registration
    types.ts                    Interfaces, error classes, constants, utility fns
    config.ts                   IMessageConfig / IMessageAccountConfig types
    accounts.ts                 Multi-account helpers; DEFAULT_ACCOUNT_ID = "default"
    chatdb-reader.ts            chat.db SQLite reader (bun:sqlite / node:sqlite)
    contacts-reader.ts          Apple Contacts reader via CNContactStore
    rpc.ts                      IMessageRpcClient — optional RPC bridge
    connector-account-provider.ts  ConnectorAccountProvider adapter
    setup-routes.ts             /api/setup/imessage/* route handlers
    data-routes.ts              /api/imessage/* CRUD route handlers
    node-sqlite.d.ts            Type shim for node:sqlite (gitignored)
    providers/
      index.ts                  (reserved)
    api/
      imessage-routes.ts        Legacy raw HTTP handler (exported, not re-registered)
      bluebubbles-routes.ts     BlueBubbles webhook handler (exported, not re-registered)
  auto-enable.ts                elizaos.plugin.autoEnableModule entry point
  package.json
  build.ts
  vitest.config.ts
```

## Commands

All scripts defined in `package.json`:

```bash
bun run --cwd plugins/plugin-imessage build           # compile to dist/
bun run --cwd plugins/plugin-imessage test            # vitest run
bun run --cwd plugins/plugin-imessage test:watch      # vitest watch
bun run --cwd plugins/plugin-imessage lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-imessage lint:check      # biome check (no write)
bun run --cwd plugins/plugin-imessage format          # biome format --write
bun run --cwd plugins/plugin-imessage format:check    # biome format (no write)
bun run --cwd plugins/plugin-imessage typecheck       # tsgo --noEmit
```

## Config / env vars

All read via `runtime.getSetting(key)` with `process.env[key]` fallback. None required; the service degrades gracefully when absent.

| Env var | Default | Description |
|---|---|---|
| `IMESSAGE_CLI_PATH` | `"imsg"` | Path to an iMessage CLI binary; fallback to AppleScript when absent or path not found |
| `IMESSAGE_DB_PATH` | `~/Library/Messages/chat.db` | Override chat.db path |
| `IMESSAGE_POLL_INTERVAL_MS` | `5000` | How often (ms) to poll chat.db for new rows; `0` disables polling |
| `IMESSAGE_HEARTBEAT_INTERVAL_MS` | `60000` | How often (ms) to run the heartbeat health check against chat.db |
| `IMESSAGE_DM_POLICY` | `"pairing"` | `open` / `pairing` / `allowlist` / `disabled` |
| `IMESSAGE_GROUP_POLICY` | `"allowlist"` | `open` / `allowlist` / `disabled` |
| `IMESSAGE_ALLOW_FROM` | `""` | Comma-separated E.164 phones or iCloud emails for allowlist |
| `IMESSAGE_ENABLED` | `"true"` | Set to `"false"` to disable |
| `IMESSAGE_BACKFILL` | `0` | Number of rows before the current DB tip to replay on startup |
| `ELIZA_NATIVE_PERMISSIONS_DYLIB` | `""` | Path to the native permissions dylib used for CNContactStore access |

Config block in character settings:

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "pollIntervalMs": 5000
    }
  }
}
```

## How to extend

**Add a new action:**
1. Create `src/actions/my-action.ts` exporting an `Action` object (see `@elizaos/core` `Action` interface).
2. Import and push it into the `actions` array in `src/index.ts`.
3. No service changes needed unless the action must call `IMessageService` directly (import `IMessageService` and call `runtime.getService(IMessageService.serviceType)`).

**Add a new provider:**
1. Create `src/providers/my-provider.ts` exporting a `Provider` object.
2. Import and push it into the `providers` array in `src/index.ts`.

**Add a new route:**
1. Write the handler in `src/data-routes.ts` or a new file.
2. Add a `Route` entry to the exported array and import it into `src/index.ts`'s `routes` spread.
3. Use `rawPath: true` to mount at the canonical path without a plugin prefix.

**Extend IMessageService:**
- Add public methods to `IMessageService` in `src/service.ts` and declare them on `IIMessageService` in `src/types.ts`.
- The connector registration object inside `IMessageService.registerSendHandlers` is the right place to extend `MessageConnector` hooks (e.g., adding a new `AdditiveMessageConnectorHooks` key).

## Conventions / gotchas

- **macOS only.** `IMessageService.start()` throws `IMessageNotSupportedError` on non-darwin platforms. The plugin still loads on other platforms but the service never starts; all route handlers return 503.
- **chat.db requires Full Disk Access.** Without it, `openChatDb` returns `null` and the service runs send-only. Guide the user to `System Settings > Privacy & Security > Full Disk Access`. The `createFullDiskAccessAction()` helper in `chatdb-reader.ts` builds the structured action object the UI needs.
- **Contacts permission is lazy.** `loadContacts()` is NOT called at service start — it fires on the first inbound message that needs handle→name resolution. This avoids a macOS TCC dialog at app launch.
- **Bun:sqlite / node:sqlite dual runtime.** `chatdb-reader.ts` tries `bun:sqlite` first, then `node:sqlite`. Neither runtime ships both. If chat.db can't be opened, the service degrades silently (logs a warning, returns send-only status).
- **Single macOS account model.** `DEFAULT_ACCOUNT_ID = "default"`. `assertLocalIMessageAccount` throws if a caller passes any other accountId. `accounts.ts` exposes connector-account inventory and config merging for the local Messages account; run separate agent processes for separate macOS user sessions.
- **Polling reentrancy guard.** `pollInFlight` prevents concurrent ticks from racing on the same cursor. If dispatch takes longer than `IMESSAGE_POLL_INTERVAL_MS`, ticks are dropped (not queued). This is intentional.
- **Message chunking.** Messages over 4000 chars (`MAX_IMESSAGE_MESSAGE_LENGTH`) are split at newlines or spaces and sent as sequential AppleScript calls.
- **BlueBubbles support.** `src/api/bluebubbles-routes.ts` exports a webhook handler for BlueBubbles (a third-party iMessage relay). It is exported from the plugin index but not auto-registered as a `Route[]`; the agent must mount it manually.
- **No npm build deps.** Only `@elizaos/core` and `zod` at runtime. The build uses `build.ts` (not a tsdown config file) invoked via `bun run build.ts`.
