# @elizaos/plugin-feishu

Feishu/Lark messaging connector for elizaOS agents. Connects an Eliza agent to ByteDance's enterprise collaboration platform (Feishu for China, Lark globally) via WebSocket event subscription and the Lark Open Platform API.

## Purpose / role

This plugin registers a `FeishuService` that opens a persistent WebSocket connection to the Feishu/Lark event subscription API. Incoming messages are handed to the agent runtime as standard elizaOS message events; outgoing messages are dispatched through the registered message connector. The plugin is opt-in and auto-enables when a `feishu` connector block is present in the agent config (see `auto-enable.ts`). It also registers a `FeishuWorkflowCredentialProvider` so workflow automations can call Feishu APIs via HTTP Request nodes without re-entering credentials.

See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).

## Plugin surface

**Services** (registered in `feishuPlugin.services`):

| Name | Class | File | Role |
|---|---|---|---|
| `feishu` | `FeishuService` | `src/service.ts` | WebSocket listener, message routing, connector registration |
| `workflow_credential_provider` | `FeishuWorkflowCredentialProvider` | `src/workflow-credential-provider.ts` | Supplies Feishu app credentials to the workflow plugin |

**Actions:** none registered.

**Providers:** none registered.

**Events emitted** (from `src/types.ts` `FeishuEventTypes`):

| Event constant | String value | Trigger |
|---|---|---|
| `FEISHU_WORLD_CONNECTED` | `FEISHU_WORLD_CONNECTED` | WebSocket connection established |
| `FEISHU_WORLD_JOINED` | `FEISHU_WORLD_JOINED` | Bot added to a chat/group |
| `FEISHU_WORLD_LEFT` | `FEISHU_WORLD_LEFT` | Bot removed from a chat/group |
| `FEISHU_ENTITY_JOINED` | `FEISHU_ENTITY_JOINED` | User joined a chat |
| `FEISHU_ENTITY_LEFT` | `FEISHU_ENTITY_LEFT` | User left a chat |
| `FEISHU_MESSAGE_RECEIVED` | `FEISHU_MESSAGE_RECEIVED` | Inbound message dispatched |
| `FEISHU_MESSAGE_SENT` | `FEISHU_MESSAGE_SENT` | Outbound message sent |
| `FEISHU_REACTION_RECEIVED` | `FEISHU_REACTION_RECEIVED` | Emoji reaction on a message |
| `FEISHU_INTERACTION_RECEIVED` | `FEISHU_INTERACTION_RECEIVED` | Interactive card action |
| `FEISHU_SLASH_START` | `FEISHU_SLASH_START` | Slash command invocation |
| `FEISHU_ENTITY_UPDATED` | `FEISHU_ENTITY_UPDATED` | User profile updated in a chat |

**Message connector** registered at `FeishuService.registerSendHandlers` with capabilities: `send_message`, `send_card`, `send_image`, `send_file`. Supports `resolveTargets`, `listRecentTargets`, `listRooms`, `fetchMessages`, `searchMessages`, `getChatContext`, `getUserContext`.

## Layout

```
plugins/plugin-feishu/
  auto-enable.ts                 Auto-enable check (env reads only, no runtime init)
  src/
    index.ts                     Plugin object export; init() registers ConnectorAccountProvider
    service.ts                   FeishuService — WebSocket lifecycle, event dispatch, send handler
    messageManager.ts            MessageManager — inbound message parsing, deduplication, runtime dispatch
    environment.ts               Config loading (getFeishuConfig), validation (validateConfig), isChatAllowed
    constants.ts                 FEISHU_SERVICE_NAME, FEISHU_DOMAINS, MAX_MESSAGE_LENGTH
    types.ts                     All Feishu-specific types: FeishuMessage, FeishuChat, FeishuUser,
                                 FeishuCard, FeishuEventTypes enum, payload interfaces
    accounts.ts                  Multi-account scaffolding: FeishuAccountConfig, resolveFeishuAccount,
                                 listEnabledFeishuAccounts, normalizeAccountId
    connector-account-provider.ts  ConnectorAccountProvider adapter over accounts.ts
    workflow-credential-provider.ts  Surfaces app credentials to workflow plugin
    config.ts                    FeishuConfig, FeishuActionConfig, FeishuReactionNotificationMode
    formatting.ts                Markdown → Feishu Post/rich-text conversion; chunkFeishuText
    connector.test.ts            Integration tests
```

## Commands

These scripts exist in `package.json`:

```bash
bun run --cwd plugins/plugin-feishu build           # compile to dist/
bun run --cwd plugins/plugin-feishu dev             # hot-rebuild (bun --hot build.ts)
bun run --cwd plugins/plugin-feishu test            # vitest run
bun run --cwd plugins/plugin-feishu test:watch      # vitest watch
bun run --cwd plugins/plugin-feishu lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-feishu format          # biome format --write
bun run --cwd plugins/plugin-feishu lint:check      # biome check (no write)
bun run --cwd plugins/plugin-feishu format:check    # biome format (no write)
bun run --cwd plugins/plugin-feishu typecheck       # tsgo --noEmit
bun run --cwd plugins/plugin-feishu clean           # rm dist .turbo tsconfig.tsbuildinfo
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` in `src/environment.ts`:

| Env var | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | Yes | Feishu/Lark app ID (`cli_xxx` format). Must start with `cli_`. |
| `FEISHU_APP_SECRET` | Yes | Feishu/Lark app secret for authentication. |
| `FEISHU_DOMAIN` | No | `"feishu"` (default, China) or `"lark"` (global). |
| `FEISHU_ALLOWED_CHATS` | No | JSON array of chat IDs the bot may interact with. Empty = all chats allowed. |
| `FEISHU_IGNORE_BOT_MESSAGES` | No | Default `true`. Set to `"false"` to process messages from other bots. |
| `FEISHU_RESPOND_ONLY_TO_MENTIONS` | No | Default `false`. Set to `"true"` to only respond when the bot is @-mentioned. |
| `FEISHU_TEST_CHAT_ID` | No | Chat ID used in the test suite. |

Multi-account configuration is read from `character.settings.feishu` (see `src/accounts.ts`, `FeishuAccountConfig`). The env-var path (`FEISHU_APP_ID` / `FEISHU_APP_SECRET`) always acts as the `"default"` account.

## How to extend

**Add a new Feishu event handler:**
1. Subscribe to the event in `setupWebSocket()` in `src/service.ts` using the Lark SDK event dispatcher string (e.g. `"im.message.reaction.created_v1"`).
2. Add a corresponding handler method on `FeishuService` and emit the right `FeishuEventTypes` value.
3. Add the event type to `FeishuEventTypes` and `FeishuEventPayloadMap` in `src/types.ts`.

**Add a new action:**
1. Create `src/actions/<name>.ts` exporting a `const <Name>Action: Action` object.
2. Import and push it into `feishuPlugin.actions` in `src/index.ts`.

**Add message formatting support:**
- Markdown-to-Feishu-Post conversion lives in `src/formatting.ts`. Add new element tags or chunk strategies there.

## Conventions / gotchas

- The Lark SDK (`@larksuiteoapi/node-sdk`) wraps both Feishu and Lark behind a `domain` flag. `lark.Domain.Feishu` and `lark.Domain.Lark` are the two values; selected by `FEISHU_DOMAIN`.
- `FEISHU_APP_ID` must start with `cli_` — `validateConfig` enforces this and logs a warning if invalid.
- The service starts with exponential-backoff retry (max 5 attempts, 2^n seconds between).
- Message deduplication is in-memory (last 1000 message IDs in a `Set`). Restarts will reprocess any messages received during downtime.
- `FeishuWorkflowCredentialProvider` registers as `workflow_credential_provider` — it duck-types the interface without importing `@elizaos/plugin-workflow` to avoid a compile-time circular dependency. Only `httpHeaderAuth` credential type is supported (no dedicated Feishu workflow node exists).
- The `auto-enable.ts` module must remain import-free of the full plugin runtime — the auto-enable engine loads it on every boot before deciding whether to load the plugin.
- Text messages are capped at 4000 characters (`MAX_MESSAGE_LENGTH` / `FEISHU_TEXT_CHUNK_LIMIT`). Use `chunkFeishuText` from `src/formatting.ts` for longer content.
