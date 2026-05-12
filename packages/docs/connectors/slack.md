# Slack Connector

Connect your agent to Slack workspaces using the `@elizaos/plugin-slack` package.

## Prerequisites

- A Slack app with a Bot Token (`xoxb-...`) and an App-Level Token (`xapp-...`) for Socket Mode
- Alternatively, a Signing Secret for HTTP webhook mode

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `SLACK_APP_TOKEN` | Yes | Slack App Token (`xapp-...`) for Socket Mode connections |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot Token (`xoxb-...`) for API authentication |
| `SLACK_USER_TOKEN` | No | Optional User Token (`xoxp-...`) for enhanced permissions |
| `SLACK_SIGNING_SECRET` | No | Slack Signing Secret for verifying HTTP webhook requests |
| `SLACK_CHANNEL_IDS` | No | Comma-separated list of channel IDs to restrict the bot to |
| `SLACK_SHOULD_IGNORE_BOT_MESSAGES` | No | If `true`, ignore messages from other bots |
| `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No | If `true`, only respond when @mentioned |

The connector auto-enables when `botToken`, `token`, or `apiKey` is truthy in the connector config and `enabled` is not explicitly `false`.

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-level-token"
    }
  }
}
```

The default transport is **Socket Mode**, which requires both `botToken` and `appToken`. Providing only `botToken` is enough to trigger auto-enable, but Socket Mode will fail to connect without `appToken`. For HTTP webhook mode, `appToken` is not needed — set `"mode": "http"` and provide a `signingSecret` instead:

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "signingSecret": "your-signing-secret",
      "mode": "http"
    }
  }
}
```

To disable:

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "enabled": false
    }
  }
}
```

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Enable **Socket Mode** and generate an **App-Level Token** (`xapp-...`).
3. Under **OAuth & Permissions**, add the required bot scopes and install to your workspace to get a **Bot Token** (`xoxb-...`).
4. Add both tokens to `connectors.slack` in your config.
5. Start your agent -- the Slack connector will auto-enable.

## Features

## Environment Variables

When the connector is loaded, the runtime pushes the following secrets from your config into `process.env` for the plugin to consume:

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-...`) for Socket Mode |
| `SLACK_USER_TOKEN` | No | User token (`xoxp-...`) for user-scoped actions |
| `SLACK_SIGNING_SECRET` | No | Signing secret for HTTP mode request verification |
| `SLACK_CHANNEL_IDS` | No | Comma-separated list of channel IDs to restrict the bot to |
| `SLACK_SHOULD_IGNORE_BOT_MESSAGES` | No | Ignore messages from other bots |
| `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No | Only respond when @mentioned |

## Transport Modes

Slack supports two transport modes:

### Socket Mode (default)

Uses WebSocket via Slack's Socket Mode API. Requires an app-level token (`xapp-...`).

```json
{
  "connectors": {
    "slack": {
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

### HTTP Mode

Receives events via HTTP webhooks. Requires a signing secret for request verification.

```json
{
  "connectors": {
    "slack": {
      "mode": "http",
      "botToken": "<SLACK_BOT_TOKEN>",
      "signingSecret": "your-signing-secret",
      "webhookPath": "/slack/events"
    }
  }
}
```

When `mode` is `"http"`, `signingSecret` is required (validated by the schema).

## Full Configuration Reference

All fields under `connectors.slack`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `botToken` | string | — | Bot token (`xoxb-...`) |
| `appToken` | string | — | App-level token (`xapp-...`) for Socket Mode |
| `userToken` | string | — | User token (`xoxp-...`) for user-scoped API calls |
| `userTokenReadOnly` | boolean | `true` | Restrict user token to read-only operations |
| `mode` | `"socket"` \| `"http"` | `"socket"` | Transport mode |
| `signingSecret` | string | — | Signing secret for HTTP mode (required when mode is `"http"`) |
| `webhookPath` | string | `"/slack/events"` | HTTP webhook endpoint path |
| `name` | string | — | Account display name |
| `enabled` | boolean | — | Explicitly enable/disable |
| `capabilities` | string[] | — | Capability flags |
| `allowBots` | boolean | `false` | Allow bot messages to trigger responses |
| `requireMention` | boolean | — | Only respond when @mentioned |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group/channel join policy |
| `historyLimit` | integer >= 0 | — | Max messages in conversation context |
| `dmHistoryLimit` | integer >= 0 | — | History limit for DMs |
| `dms` | Record\<string, \{historyLimit?\}\> | — | Per-DM history overrides |
| `textChunkLimit` | integer > 0 | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | Long message splitting strategy |
| `blockStreaming` | boolean | — | Disable streaming responses |
| `blockStreamingCoalesce` | object | — | Coalescing: `minChars`, `maxChars`, `idleMs` |
| `mediaMaxMb` | number > 0 | — | Max media file size in MB |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Reply threading mode |
| `configWrites` | boolean | `true` | Allow config writes from Slack events |
| `markdown` | object | — | Table rendering: `tables` can be `"off"`, `"bullets"`, or `"code"` |
| `commands` | object | — | `native` and `nativeSkills` toggles |

### Reply-To Mode by Chat Type

Override `replyToMode` per chat type:

```json
{
  "connectors": {
    "slack": {
      "replyToModeByChatType": {
        "direct": "all",
        "group": "first",
        "channel": "off"
      }
    }
  }
}
```

### Actions

| Field | Type | Description |
|-------|------|-------------|
| `actions.reactions` | boolean | Add reactions |
| `actions.messages` | boolean | Send messages |
| `actions.pins` | boolean | Pin messages |
| `actions.search` | boolean | Search messages |
| `actions.permissions` | boolean | Manage permissions |
| `actions.memberInfo` | boolean | View member info |
| `actions.channelInfo` | boolean | View channel info |
| `actions.emojiList` | boolean | List available emoji |

### Reaction Notifications

| Field | Type | Description |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | Which reactions trigger notifications |
| `reactionAllowlist` | (string\|number)[] | Reaction names to notify on (when using `"allowlist"`) |

### DM Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dm.enabled` | boolean | — | Enable/disable DMs |
| `dm.policy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy |
| `dm.allowFrom` | (string\|number)[] | — | Allowed user IDs. Must include `"*"` for `"open"` policy |
| `dm.groupEnabled` | boolean | — | Enable group DMs |
| `dm.groupChannels` | (string\|number)[] | — | Allowed group DM channel IDs |
| `dm.replyToMode` | `"off"` \| `"first"` \| `"all"` | — | DM-specific reply threading |

### Thread Configuration

| Field | Type | Description |
|-------|------|-------------|
| `thread.historyScope` | `"thread"` \| `"channel"` | `"thread"` isolates history per thread. `"channel"` reuses channel conversation history |
| `thread.inheritParent` | boolean | Whether thread sessions inherit the parent channel transcript (default: false) |

### Slash Commands

```json
{
  "connectors": {
    "slack": {
      "slashCommand": {
        "enabled": true,
        "name": "agent",
        "sessionPrefix": "slash",
        "ephemeral": true
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `slashCommand.enabled` | boolean | Enable slash command handling |
| `slashCommand.name` | string | Slash command name (e.g., `/agent`) |
| `slashCommand.sessionPrefix` | string | Session ID prefix for slash command conversations |
| `slashCommand.ephemeral` | boolean | Send responses as ephemeral (visible only to invoker) |

### Channel Configuration

Per-channel settings under `channels.<channel-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable this channel |
| `allow` | boolean | Allow bot in this channel |
| `requireMention` | boolean | Only respond when @mentioned |
| `tools` | ToolPolicySchema | Tool access policy |
| `toolsBySender` | Record\<string, ToolPolicySchema\> | Per-sender tool policies |
| `allowBots` | boolean | Allow bot messages in this channel |
| `users` | (string\|number)[] | Allowed user IDs |
| `skills` | string[] | Allowed skills |
| `systemPrompt` | string | Channel-specific system prompt |

### Heartbeat

```json
{
  "connectors": {
    "slack": {
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

```json
{
  "connectors": {
    "slack": {
      "accounts": {
        "workspace-1": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" },
        "workspace-2": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" }
      }
    }
  }
}
```

## Related

- [Slack plugin reference](/plugin-registry/platform/slack)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
