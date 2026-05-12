# LINE Connector

Connect your agent to LINE for bot messaging and customer conversations using the `@elizaos/plugin-line` package.

## Prerequisites

The LINE connector is an elizaOS plugin that bridges your agent to LINE Messaging API. It supports rich message types, group chat, and webhook-based event handling. This connector is available from the plugin registry.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-line` |
| Config key | `connectors.line` |
| Install | `eliza plugins install @elizaos/plugin-line` |

## Setup

### 1. Create a LINE Messaging API Channel

1. Go to [LINE Developers Console](https://developers.line.biz/console/)
2. Create a new provider (or use an existing one)
3. Create a new **Messaging API** channel
4. Under the **Messaging API** tab, issue a **Channel access token**
5. Note the **Channel secret** from the **Basic settings** tab

### 2. Configure Eliza

| Name | Required | Description |
|------|----------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | Channel access token from LINE Developer Console |
| `LINE_CHANNEL_SECRET` | No | Channel secret for webhook verification |
| `LINE_ENABLED` | No | Enable or disable the connector |
| `LINE_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `LINE_ALLOW_FROM` | No | Comma-separated allowed user list |
| `LINE_GROUP_POLICY` | No | Group message policy (e.g., `allow`, `deny`) |
| `LINE_WEBHOOK_PATH` | No | Webhook endpoint path |

Install the plugin from the registry:

```bash
eliza plugins install line
```

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "line": {
      "channelAccessToken": "YOUR_CHANNEL_ACCESS_TOKEN",
      "channelSecret": "YOUR_CHANNEL_SECRET"
    }
  }
}
```

Or via environment variables:

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | Channel access token from LINE Developers Console |
| `LINE_CHANNEL_SECRET` | Yes | Channel secret for webhook verification |
| `LINE_ENABLED` | No | Set to `true` to enable |
| `LINE_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `LINE_ALLOW_FROM` | No | Comma-separated allowed user list |
| `LINE_GROUP_POLICY` | No | Group message policy (e.g., `allow`, `deny`) |
| `LINE_WEBHOOK_PATH` | No | Webhook endpoint path |

## Configuration Reference

| Field | Required | Description |
|-------|----------|-------------|
| `channelAccessToken` | Yes | LINE Messaging API channel access token |
| `channelSecret` | Yes | LINE channel secret |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Features

- Bot messaging and customer conversations
- Rich message types (text, sticker, image, video)
- Group chat support
- DM and group message policies
- Webhook-based event handling

## Related

- [LINE Plugin Reference](/plugin-registry/platform/line)
- [Connectors overview](/guides/connectors#line)
