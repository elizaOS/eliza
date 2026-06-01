# @elizaos/plugin-google-chat

Google Chat connector for elizaOS agents. Sends and receives messages in Google Workspace spaces, DMs, and threads via the Google Chat REST API.

This package is a runtime plugin consumed by an elizaOS agent. It registers two services and a `MessageConnector` (`source: "google-chat"`); there are no actions or providers. For agent/contributor-facing detail, see [CLAUDE.md](./CLAUDE.md).

## What it provides

- Send/receive messages in spaces, threaded replies, and 1:1 DMs.
- Emoji reactions (`sendReaction` / `deleteReaction`), message edit (`updateMessage`) and delete (`deleteMessage`).
- Attachment upload (multipart to `https://chat.googleapis.com/upload/v1`) and download (`?alt=media`).
- Multiple concurrent bot accounts via one service instance.
- Inbound webhook events through `GoogleChatService.processWebhookEvent()`. This plugin does not mount its own HTTP route — the host runtime forwards events to it at the configured `webhookPath`.

Auth uses a Google service account with scope `https://www.googleapis.com/auth/chat.bot`. There is no OAuth user flow.

## Usage

```typescript
import googleChatPlugin from "@elizaos/plugin-google-chat";
```

Add the plugin to the runtime's plugin list, or let auto-enable activate it when a `connectors.googlechat` block is present in the character config (see `auto-enable.ts`).

## Configuration

Resolution order: per-account character config > top-level `character.settings.googleChat` > `GOOGLE_CHAT_ACCOUNTS` JSON env var > single-account env vars (only for the `default` account).

| Env var | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | One of three | — | Inline service account JSON string |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` | One of three | — | Path to service account JSON key file |
| `GOOGLE_APPLICATION_CREDENTIALS` | One of three | — | ADC credentials file path (standard Google env var) |
| `GOOGLE_CHAT_AUDIENCE` | Yes | — | Audience value for webhook token verification by the host |
| `GOOGLE_CHAT_AUDIENCE_TYPE` | No | `app-url` | `app-url` or `project-number` |
| `GOOGLE_CHAT_WEBHOOK_PATH` | No | `/googlechat` | Webhook path for incoming events |
| `GOOGLE_CHAT_SPACES` | No | — | Comma-separated initial space resource names (`spaces/xxx`) |
| `GOOGLE_CHAT_REQUIRE_MENTION` | No | `true` | Only respond in spaces when @mentioned |
| `GOOGLE_CHAT_BOT_USER` | No | — | Bot user resource name (`users/xxx`) |
| `GOOGLE_CHAT_ENABLED` | No | `true` | Master switch for this plugin |
| `GOOGLE_CHAT_ACCOUNTS` | No | — | JSON array/object for multi-account config |
| `GOOGLE_CHAT_DEFAULT_ACCOUNT_ID` | No | `default` | Active account when multiple are configured |

Character-level config (`character.settings.googleChat`) accepts all `GoogleChatAccountConfig` fields (`src/config.ts`): per-space overrides, DM policies, reaction-notification modes, `textChunkLimit` (default 4096), `mediaMaxMb` (default 50), and heartbeat visibility.

## Events

Emitted via `runtime.emitEvent` (constants in `GoogleChatEventTypes`, `src/types.ts`):

| Event | Fired when |
|---|---|
| `GOOGLE_CHAT_MESSAGE_RECEIVED` | Webhook receives a `MESSAGE` event |
| `GOOGLE_CHAT_MESSAGE_SENT` | `sendMessage` succeeds |
| `GOOGLE_CHAT_SPACE_JOINED` | Bot added to a space |
| `GOOGLE_CHAT_SPACE_LEFT` | Bot removed from a space |
| `GOOGLE_CHAT_REACTION_SENT` | `sendReaction` succeeds |
| `GOOGLE_CHAT_CONNECTION_READY` | Account connected at startup |

`GOOGLE_CHAT_REACTION_RECEIVED` and `GOOGLE_CHAT_WEBHOOK_READY` are declared in the enum but not currently emitted.

## Commands

From `package.json`:

```bash
bun run --cwd plugins/plugin-google-chat build         # bunx tsc -p tsconfig.json
bun run --cwd plugins/plugin-google-chat test          # vitest run
bun run --cwd plugins/plugin-google-chat lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-google-chat typecheck     # tsgo --noEmit
```

Messages longer than 4,000 chars (`MAX_GOOGLE_CHAT_MESSAGE_LENGTH`) can be split with `splitMessageForGoogleChat` (`src/types.ts`), which breaks on newline or word boundaries.

This plugin is separate from `@elizaos/plugin-google` (OAuth for Drive/Calendar). Auth scopes and audience models differ — do not merge.
