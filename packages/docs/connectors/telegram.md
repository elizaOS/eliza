# Telegram Connector

Connect your agent to Telegram for private chats and group conversations using the `@elizaos/plugin-telegram` package.

## Prerequisites

- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_API_ROOT` | No | Base URL for Telegram Bot API (allows overriding the default endpoint) |
| `TELEGRAM_ALLOWED_CHATS` | No | JSON-encoded array of chat IDs authorized to interact with the bot |
| `TELEGRAM_TEST_CHAT_ID` | No | Chat ID used by the test suite for validation |

The connector auto-enables when `botToken`, `token`, or `apiKey` is truthy in the connector config and `enabled` is not explicitly `false`.

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "telegram": {
      "botToken": "your-telegram-bot-token"
    }
  }
}
```

## Disabling

To explicitly disable the connector even when a token is present:

```json
{
  "connectors": {
    "telegram": {
      "botToken": "your-telegram-bot-token",
      "enabled": false
    }
  }
}
```

## Setup

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Use `/newbot` to create a new bot and copy the **bot token**.
3. Add the token to `connectors.telegram.botToken` in your config.
4. Start your agent -- the Telegram connector will auto-enable.

## Features

## Environment Variables

When the connector is loaded, the runtime pushes the following secret from your config into `process.env` for the plugin to consume:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_API_ROOT` | No | Override the default Telegram Bot API base URL |
| `TELEGRAM_ALLOWED_CHATS` | No | JSON-encoded array of authorized chat IDs |

## Full Configuration Reference

All fields are defined under `connectors.telegram` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `botToken` | string | — | Bot token from BotFather |
| `tokenFile` | string | — | Path to file containing bot token (alternative to inline) |
| `name` | string | — | Account display name |
| `enabled` | boolean | — | Explicitly enable/disable |
| `capabilities` | string[] or object | — | Capability flags. Object form supports `inlineButtons`: `"off"`, `"dm"`, `"group"`, `"all"`, or `"allowlist"` |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy. `"open"` requires `allowFrom` to include `"*"` |
| `allowFrom` | (string\|number)[] | — | User IDs allowed to DM |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group join policy |
| `groupAllowFrom` | (string\|number)[] | — | User IDs allowed in groups |
| `historyLimit` | integer >= 0 | — | Max messages in context |
| `dmHistoryLimit` | integer >= 0 | — | History limit for DMs |
| `dms` | object | — | Per-DM history overrides keyed by DM ID. Each value: `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | Long message splitting strategy |
| `mediaMaxMb` | number > 0 | — | Max media file size in MB |
| `configWrites` | boolean | true | Allow config writes from Telegram events |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Reply threading mode |
| `linkPreview` | boolean | — | Enable/disable link previews |
| `timeoutSeconds` | integer > 0 | 500 | grammY request timeout |
| `proxy` | string | — | Proxy URL for Telegram API requests |
| `markdown` | object | — | Table rendering: `tables` can be `"off"`, `"bullets"`, or `"code"` |
| `commands` | object | — | `native` and `nativeSkills` command toggles |

### Streaming Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `streamMode` | `"off"` \| `"partial"` \| `"block"` | `"partial"` | `"partial"` sends incremental message edits. `"block"` waits for full response. `"off"` disables streaming |
| `blockStreaming` | boolean | — | Disable streaming entirely |
| `blockStreamingCoalesce` | object | — | Coalescing settings: `minChars`, `maxChars`, `idleMs` |
| `draftChunk` | object | — | Draft chunking settings (see below) |

Draft chunk controls how partial streaming messages are split:

| Field | Type | Description |
|-------|------|-------------|
| `draftChunk.minChars` | integer | Minimum characters before sending a draft |
| `draftChunk.maxChars` | integer | Maximum characters per draft chunk |
| `draftChunk.breakPreference` | `"paragraph"` \| `"newline"` \| `"sentence"` | Where to prefer breaking drafts |

### Actions

| Field | Type | Description |
|-------|------|-------------|
| `actions.reactions` | boolean | Send reactions |
| `actions.sendMessage` | boolean | Send messages |
| `actions.deleteMessage` | boolean | Delete messages |
| `actions.sticker` | boolean | Send stickers |

### Reaction Notifications

| Field | Type | Description |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` | Which reactions trigger notifications |
| `reactionLevel` | `"off"` \| `"ack"` \| `"minimal"` \| `"extensive"` | Reaction response verbosity |

### Custom Bot Commands

Define custom entries in the Telegram bot command menu:

```json
{
  "connectors": {
    "telegram": {
      "customCommands": [
        { "command": "status", "description": "Check agent status" },
        { "command": "help", "description": "Show help message" }
      ]
    }
  }
}
```

### Group Configuration

Per-group settings are defined under `groups.<group-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `requireMention` | boolean | Only respond when @mentioned |
| `tools` | ToolPolicySchema | Tool access policy |
| `toolsBySender` | object | Per-sender tool policies (keyed by sender ID) |
| `skills` | string[] | Allowed skills |
| `enabled` | boolean | Enable/disable this group |
| `allowFrom` | (string\|number)[] | Allowed user IDs |
| `systemPrompt` | string | Group-specific system prompt |

### Topic Configuration

Per-topic settings are defined within a group under `groups.<group-id>.topics.<topic-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `requireMention` | boolean | Only respond when @mentioned |
| `skills` | string[] | Allowed skills |
| `enabled` | boolean | Enable/disable this topic |
| `allowFrom` | (string\|number)[] | Allowed user IDs |
| `systemPrompt` | string | Topic-specific system prompt |

### Webhooks

For production deployments, use webhooks instead of polling:

```json
{
  "connectors": {
    "telegram": {
      "webhookUrl": "https://your-domain.com/telegram/webhook",
      "webhookSecret": "your-webhook-secret",
      "webhookPath": "/telegram/webhook"
    }
  }
}
```

When `webhookUrl` is set, `webhookSecret` is required.

### Network and Retry

| Field | Type | Description |
|-------|------|-------------|
| `network.autoSelectFamily` | boolean | Auto-select IPv4/IPv6 |
| `retry.attempts` | integer | Max retry attempts |
| `retry.minDelayMs` | integer | Minimum retry delay |
| `retry.maxDelayMs` | integer | Maximum retry delay |
| `retry.jitter` | number | Jitter factor |

### Heartbeat

```json
{
  "connectors": {
    "telegram": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

### Multi-Account Support

The `accounts` field allows running multiple Telegram bots from a single agent:

```json
{
  "connectors": {
    "telegram": {
      "accounts": {
        "bot-1": { "botToken": "...", "groups": { } },
        "bot-2": { "botToken": "...", "groups": { } }
      }
    }
  }
}
```

## Related

- [Telegram plugin reference](/plugin-registry/platform/telegram)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
