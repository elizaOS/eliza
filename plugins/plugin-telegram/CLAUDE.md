# @elizaos/plugin-telegram

Connects an Eliza agent to Telegram via the Bot API, enabling bidirectional messaging across private chats, groups, supergroups, channels, and forum topics.

## Purpose / role

This plugin adds a `TelegramService` that polls Telegram for incoming messages and reactions, routes them through the elizaOS runtime, and sends agent responses back. It also provides an owner-pairing service for binding a Telegram user to an agent owner account. The plugin auto-enables when the `telegram` connector key is present in the agent's `eliza.json` connector config (`autoEnable.connectorKeys: ["telegram"]`); it can also be loaded explicitly as a dependency.

## Plugin surface

**Services** (registered in order — order matters):

| Service class | `serviceType` | What it does |
|---|---|---|
| `TelegramService` | `"telegram"` | Launches a Telegraf long-poll bot, processes `message` + `message_reaction` events, manages multi-account state, registers the agent as a `MessageConnector` |
| `TelegramOwnerPairingServiceImpl` | `"OWNER_PAIRING_TELEGRAM"` | Registers `/eliza_pair <code>` bot command; provides `sendOwnerLoginDmLink` called by auth backend to DM login links |

**Routes** (all `rawPath: true` — no plugin-name prefix):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup/telegram/status` | Bot-token setup state (`idle` / `configuring` / `paired`) |
| POST | `/api/setup/telegram/start` | Validate + save bot token, probe `getMe`, register escalation channel |
| POST | `/api/setup/telegram/cancel` | Remove saved token |
| GET | `/api/setup/telegram-account/status` | GramJS user-account auth state |
| POST | `/api/setup/telegram-account/start` | Begin GramJS login (phone + optional app credentials) |
| POST | `/api/setup/telegram-account/submit-code` | Submit provisioning code, Telegram OTP, or 2FA password |
| POST | `/api/setup/telegram-account/cancel` | Tear down GramJS session + clear saved credentials |

**Events emitted** (`TelegramEventTypes` in `src/types.ts`):

`TELEGRAM_WORLD_JOINED`, `TELEGRAM_WORLD_CONNECTED`, `TELEGRAM_WORLD_LEFT`, `TELEGRAM_ENTITY_JOINED`, `TELEGRAM_ENTITY_LEFT`, `TELEGRAM_ENTITY_UPDATED`, `TELEGRAM_MESSAGE_RECEIVED`, `TELEGRAM_MESSAGE_SENT`, `TELEGRAM_REACTION_RECEIVED`, `TELEGRAM_INTERACTION_RECEIVED`, `TELEGRAM_SLASH_START`

Also emits the core `EventType.WORLD_JOINED` on new chat discovery.

**No actions, providers, or evaluators are registered by this plugin.**

## Layout

```
src/
  index.ts                    Plugin object, init/dispose lifecycle
  service.ts                  TelegramService — bot lifecycle, middleware, MessageConnector registration
  messageManager.ts           Per-account message handling, media ingestion, response dispatch
  owner-pairing-service.ts    TelegramOwnerPairingServiceImpl + handleElizaPairCommand
  setup-routes.ts             Bot-token setup HTTP routes (telegramSetupRoutes)
  account-setup-routes.ts     GramJS user-account auth HTTP routes (telegramAccountRoutes)
  account-auth-service.ts     TelegramAccountAuthSession — GramJS MTProto auth state machine
  accounts.ts                 Multi-account config resolution (resolveTelegramAccount, listEnabledTelegramAccounts)
  connector-account-provider.ts  ConnectorAccountManager bridge (CRUD, no OAuth)
  interactions.ts             renderTelegramInteractions — inline keyboard / interaction rendering
  command-registration.ts     buildTelegramCommandDescriptors, registerTelegramCommandHandlers, applyTelegramSetMyCommands
  local-client.ts             TELEGRAM_LOCAL_MOCK_SESSION_PREFIX — mock session helpers
  sensitive-request-adapter.ts  telegramDmSensitiveRequestAdapter, registerTelegramDmSensitiveRequestAdapter
  constants.ts                TELEGRAM_SERVICE_NAME = "telegram"; MESSAGE_CONSTANTS
  types.ts                    TelegramContent, Button, TelegramEventTypes, payload interfaces
  utils.ts                    cleanText, convertMarkdownToTelegram, convertToTelegramButtons
  tests.ts                    TelegramTestSuite (live smoke, requires TELEGRAM_TEST_CHAT_ID)
  messageManager.test.ts      Unit tests for MessageManager (vitest, mocked runtime)
  messageConnector.test.ts    Unit tests for connector registration and send routing (vitest, mocked runtime)
  command-registration.test.ts  Unit tests for command registration helpers
  connector-account-provider.test.ts  Unit tests for ConnectorAccountProvider
  interactions-roundtrip.test.ts  Round-trip tests for interaction rendering
  interactions.test.ts        Unit tests for interaction rendering
```

## Commands

```bash
bun run --cwd plugins/plugin-telegram build          # tsup + tsc type declarations
bun run --cwd plugins/plugin-telegram dev            # tsup --watch
bun run --cwd plugins/plugin-telegram test           # vitest run (unit)
bun run --cwd plugins/plugin-telegram test:watch     # vitest interactive
bun run --cwd plugins/plugin-telegram test:e2e       # live smoke via run-local-plugin-live-smoke.mjs
bun run --cwd plugins/plugin-telegram lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-telegram lint:check     # biome check (no write)
bun run --cwd plugins/plugin-telegram format         # biome format --write
bun run --cwd plugins/plugin-telegram format:check   # biome format (no write)
bun run --cwd plugins/plugin-telegram clean          # rm dist .turbo
```

## Config / env vars

| Var | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes (default account) | Bot token from @BotFather; format `<id>:<alphanum>`. Read via `runtime.getSetting()` then `process.env`. |
| `TELEGRAM_API_ROOT` | No | Override Telegram Bot API base URL (default `https://api.telegram.org`). Allows local Bot API server. |
| `TELEGRAM_ALLOWED_CHATS` | No | JSON array of chat ID strings that the bot will respond to. If absent, all chats are allowed. Read via `runtime.getSetting()`. |
| `TELEGRAM_TEST_CHAT_ID` | No | Chat ID used by `TelegramTestSuite` for live smoke tests. |

Multi-account configuration is declared on `character.settings.telegram`:

```json
{
  "settings": {
    "telegram": {
      "botToken": "...",
      "apiRoot": "...",
      "accounts": {
        "myBot": { "botToken": "...", "allowedChats": ["-100123"] }
      }
    }
  }
}
```

Account resolution order (for the `default` account): `character.settings.telegram.botToken` → `TELEGRAM_BOT_TOKEN` runtime setting → `process.env.TELEGRAM_BOT_TOKEN`.

## How to extend

**Add a new action**: Create `src/actions/my-action.ts`, export an `Action` object conforming to `@elizaos/core`'s `Action` interface, then add it to the `actions` array in the plugin object in `src/index.ts`.

**Add a provider**: Create `src/providers/my-provider.ts`, export a `Provider` object, add to `providers` in `src/index.ts`.

**Add a service**: Extend `Service` from `@elizaos/core`, set a static `serviceType` string, implement `static async start(runtime)` and optionally `async stop()`. Add to the `services` array. Note: `TelegramService` must remain first so its bot instance is available when `TelegramOwnerPairingServiceImpl` starts.

**Add a route**: Define a `Route` object (see `@elizaos/core`'s `Route` type) and push it into `telegramSetupRoutes` or a new array merged in `src/index.ts`. Use `rawPath: true` to bypass the plugin-name path prefix.

**Emit a new event**: Add to `TelegramEventTypes` in `src/types.ts`, extend `TelegramEventPayloadMap`, and call `runtime.emitEvent(TelegramEventTypes.MY_EVENT, payload)`.

## Conventions / gotchas

- **One bot token per Telegram long-poll session.** If two agent instances share the same token they will 409-conflict. The plugin tracks active pollers in `ACTIVE_TELEGRAM_POLLERS` (module-level `Map`) and stops the previous poller before launching a new one.
- **`TelegramService` must start before `TelegramOwnerPairingServiceImpl`** — the pairing service's `start` looks up the live Telegraf `bot` instance from the already-running `TelegramService`.
- **Message sending**: use `MessageManager` (available as `TelegramService.messageManager`). Markdown is converted to Telegram MarkdownV2 via `convertMarkdownToTelegram` in `utils.ts`. Messages longer than 4096 characters are split.
- **Forum topics**: each thread becomes a separate `Room` with `channelId` of the form `<chatId>-<threadId>`. Room metadata includes `isForumTopic: true`.
- **Buttons**: send `TelegramContent` with a `buttons` array (`Button[]`). Supported `kind` values: `"login"`, `"url"`.
- **GramJS (user-account)**: `account-auth-service.ts` uses the `telegram` npm package (GramJS/MTProto) for user-account login, distinct from the bot-API `telegraf` package used for bot accounts.
- **ConnectorAccountManager**: registered in `init()`. Telegram bot accounts use long-lived bot tokens rather than OAuth, so start/complete OAuth flows are unsupported by design. Single-account env configs are surfaced as a synthetic `"default"` account.
- **Sensitive request adapter**: `registerTelegramDmSensitiveRequestAdapter` (called in `init()`) wires Telegram DM delivery for secret / OAuth link-out requests, mirroring the Discord DM adapter.
- See repo root `AGENTS.md` for architecture rules, logging standards, and git workflow.
