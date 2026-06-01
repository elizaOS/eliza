# @elizaos/plugin-google-chat

Google Chat connector for elizaOS agents — sends and receives messages in Google Workspace spaces, DMs, and threads via the Chat REST API.

## Purpose / role

This plugin adds Google Chat as a messaging surface for an Eliza agent. It registers two services — `GoogleChatService` (the main connector) and `GoogleChatWorkflowCredentialProvider` — and hooks into the runtime's `MessageConnector` system so the agent can send messages, react, edit, delete, list spaces, and handle DMs.

Auto-enabled when a `connectors.googlechat` block is present in agent config and not explicitly disabled (`enabled !== false`). The plugin name is `"google-chat"` and the npm package is `@elizaos/plugin-google-chat`.

## Plugin surface

### Services

| Service | `serviceType` | Description |
|---|---|---|
| `GoogleChatService` | `"google-chat"` | Main Chat API client. Registers a `MessageConnector` with `send_message`, `send_thread_reply`, `send_attachment`, `send_reaction`, `list_spaces`, `direct_message` capabilities. Processes incoming webhook events. Supports multiple concurrent bot accounts. |
| `GoogleChatWorkflowCredentialProvider` | `"workflow_credential_provider"` | Supplies `googleChatOAuth2Api` credentials to the workflow plugin. Duck-typed; no compile-time dependency on `plugin-workflow`. |

### Actions / Providers / Evaluators

None registered directly. Messaging routes entirely through the `MessageConnector` registered by `GoogleChatService` using `source: "google-chat"`. The `actions/index.ts` and `providers/index.ts` stubs exist but are empty by design.

### Events emitted (via `runtime.emitEvent`)

| Constant | Event string | Fired when |
|---|---|---|
| `GoogleChatEventTypes.MESSAGE_RECEIVED` | `GOOGLE_CHAT_MESSAGE_RECEIVED` | Webhook receives a `MESSAGE` event |
| `GoogleChatEventTypes.MESSAGE_SENT` | `GOOGLE_CHAT_MESSAGE_SENT` | `sendMessage` succeeds |
| `GoogleChatEventTypes.SPACE_JOINED` | `GOOGLE_CHAT_SPACE_JOINED` | Bot added to a space |
| `GoogleChatEventTypes.SPACE_LEFT` | `GOOGLE_CHAT_SPACE_LEFT` | Bot removed from a space |
| `GoogleChatEventTypes.REACTION_SENT` | `GOOGLE_CHAT_REACTION_SENT` | `sendReaction` succeeds |
| `GoogleChatEventTypes.CONNECTION_READY` | `GOOGLE_CHAT_CONNECTION_READY` | Account connected at startup |
| `GoogleChatEventTypes.WEBHOOK_READY` | `GOOGLE_CHAT_WEBHOOK_READY` | (declared, not currently emitted internally) |

## Layout

```
plugins/plugin-google-chat/
  src/
    index.ts                       Plugin definition, init hook, re-exports
    service.ts                     GoogleChatService — Chat REST API client, MessageConnector registration
    workflow-credential-provider.ts GoogleChatWorkflowCredentialProvider service
    accounts.ts                    Multi-account config resolution, env var parsing
    connector-account-provider.ts  ConnectorAccountManager adapter (lists/patches accounts)
    config.ts                      GoogleChatConfig / GoogleChatAccountConfig / GoogleChatSpaceConfig types
    types.ts                       Core interfaces, enums, error classes, utility functions
    actions/index.ts               Empty stub (messaging routes through MessageConnector)
    providers/index.ts             Empty stub
    connector.test.ts              Vitest tests for connector behavior
  auto-enable.ts                   shouldEnable() — checked by plugin-auto-enable-engine at boot
  package.json
  build.ts
  vitest.config.ts
```

## Commands

Scripts available in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-google-chat build         # tsdown build to dist/
bun run --cwd plugins/plugin-google-chat test          # vitest run (single pass)
bun run --cwd plugins/plugin-google-chat test:watch    # vitest watch
bun run --cwd plugins/plugin-google-chat lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-google-chat lint:check    # biome check (no write)
bun run --cwd plugins/plugin-google-chat format        # biome format --write
bun run --cwd plugins/plugin-google-chat format:check  # biome format (no write)
bun run --cwd plugins/plugin-google-chat typecheck     # tsgo --noEmit
```

## Config / env vars

Resolution order: per-account character config block > top-level `character.settings.googleChat` > `GOOGLE_CHAT_ACCOUNTS` JSON env var > single-account env vars (only for the `"default"` account).

| Env var | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | One of three | — | Inline service account JSON string |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` | One of three | — | Path to service account JSON key file |
| `GOOGLE_APPLICATION_CREDENTIALS` | One of three | — | ADC credentials file path (standard Google env var) |
| `GOOGLE_CHAT_AUDIENCE` | Yes | — | Audience value for webhook token verification |
| `GOOGLE_CHAT_AUDIENCE_TYPE` | Yes | `"app-url"` | `"app-url"` or `"project-number"` |
| `GOOGLE_CHAT_WEBHOOK_PATH` | No | `"/googlechat"` | Webhook path for incoming events |
| `GOOGLE_CHAT_SPACES` | No | — | Comma-separated list of initial space resource names (`spaces/xxx`) |
| `GOOGLE_CHAT_REQUIRE_MENTION` | No | `true` | Only respond in spaces when @mentioned |
| `GOOGLE_CHAT_BOT_USER` | No | — | Bot user resource name (`users/xxx`) |
| `GOOGLE_CHAT_ENABLED` | No | `true` | Master switch for this plugin |
| `GOOGLE_CHAT_ACCOUNTS` | No | — | JSON array/object for multi-account config |
| `GOOGLE_CHAT_DEFAULT_ACCOUNT_ID` | No | `"default"` | Active account when multiple are configured |

Character-level config (`character.settings.googleChat`) accepts all fields in `GoogleChatAccountConfig` (see `src/config.ts`), including per-space overrides (`spaces: Record<string, GoogleChatSpaceConfig>`), DM policies, reaction notification modes, text chunk limits, and heartbeat visibility.

## How to extend

**Add a new MessageConnector capability** (e.g., slash-command handling): extend the `registration` object inside `GoogleChatService.registerSendHandlers` in `src/service.ts`. Add the capability string to the `capabilities` array and implement the corresponding handler field.

**Add an action**: create a file in `src/actions/`, implement the `Action` interface from `@elizaos/core`, and add it to the `actions: []` array in `src/index.ts`.

**Add a provider**: create a file in `src/providers/`, implement `Provider`, and add it to `providers: []` in `src/index.ts`.

**Add a new account config field**: extend `GoogleChatAccountConfig` in `src/config.ts` and `GoogleChatSettings` in `src/types.ts`, then wire the resolution in `resolveGoogleChatAccountSettings` in `src/accounts.ts`.

## Conventions / gotchas

- **No actions or providers** are registered today — all capabilities are surfaced through the `MessageConnector` contract. Do not add actions unless they require planner-level reasoning that the connector hooks cannot express.
- **Multi-account**: one `GoogleChatService` instance manages multiple `GoogleChatAccountState` entries (keyed by `accountId`). `getState(accountId)` throws if the account is unknown — do not assume a fallback.
- **Webhook events** are delivered by the host runtime to `GoogleChatService.processWebhookEvent()`. The plugin does not register its own HTTP route — the caller (e.g., API server) must mount the webhook path from `settings.webhookPath`.
- **Message chunking**: `splitMessageForGoogleChat` (in `src/types.ts`) breaks long text at 4,000 chars. Text is chunked on newline or word boundary, not mid-word.
- **Attachment upload** uses multipart/related to `https://chat.googleapis.com/upload/v1/...`. Download uses `?alt=media` on the media endpoint.
- **Auth scope**: `https://www.googleapis.com/auth/chat.bot` — service account only, no OAuth user flows.
- **`GOOGLE_CHAT_AUDIENCE` is strictly required**. The service will throw `GoogleChatConfigurationError` at startup if it is missing.
- This plugin is separate from `@elizaos/plugin-google` (OAuth for Drive/Calendar etc.). Do not merge; the auth scopes and audience models are different.
