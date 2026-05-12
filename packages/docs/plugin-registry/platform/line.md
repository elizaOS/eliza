---
title: "LINE Plugin"
sidebarTitle: "LINE"
description: "LINE connector for Eliza — bot integration with the LINE messaging platform."
---

The LINE plugin connects Eliza agents to LINE as a bot, enabling message handling in chats and groups.

**Package:** `@elizaos/plugin-line`

## Installation

```bash
eliza plugins install @elizaos/plugin-line
```

## Setup

### 1. Create a LINE Messaging API Channel

1. Go to [LINE Developers Console](https://developers.line.biz/console/)
2. Create a new provider (or use an existing one)
3. Create a new **Messaging API** channel
4. Under the **Messaging API** tab, issue a **Channel access token**
5. Note the **Channel secret** from the **Basic settings** tab

### 2. Configure Eliza

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

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `channelAccessToken` | Yes | LINE Messaging API channel access token |
| `channelSecret` | No | LINE channel secret (for webhook verification) |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | LINE channel access token (primary auto-enable trigger) |
| `LINE_CHANNEL_SECRET` | No | LINE channel secret for webhook verification |
| `LINE_ENABLED` | No | Enable or disable the connector |
| `LINE_DM_POLICY` | No | DM acceptance policy |
| `LINE_ALLOW_FROM` | No | Comma-separated allowed user IDs |
| `LINE_GROUP_POLICY` | No | Group message policy |
| `LINE_WEBHOOK_PATH` | No | Webhook endpoint path |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
