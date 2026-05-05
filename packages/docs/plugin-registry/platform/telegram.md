---
title: "Telegram Plugin"
sidebarTitle: "Telegram"
description: "Telegram bot connector for Eliza — messaging, groups, inline queries, and media handling."
---

The Telegram plugin connects Eliza agents to Telegram as a bot, handling private messages, group chats, inline queries, and media sharing.

**Package:** `@elizaos/plugin-telegram`

## Installation

```bash
eliza plugins install @elizaos/plugin-telegram
```

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. BotFather will give you a bot token in the format `123456789:ABCdef...`

### 2. Configure Eliza

```json
{
  "connectors": {
    "telegram": {
      "botToken": "123456789:ABCdef..."
    }
  }
}
```

Or via environment variable:

```bash
export TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `botToken` | Yes | Telegram bot token from BotFather |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `dmPolicy` | No | DM access policy: `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` (default: `"pairing"`) |
| `allowFrom` | No | User IDs allowed to DM (required when `dmPolicy` is `"open"`, must include `"*"`) |
| `groupPolicy` | No | Group join policy: `"open"`, `"disabled"`, or `"allowlist"` (default: `"allowlist"`) |
| `webhookUrl` | No | Use webhook instead of polling (requires HTTPS URL) |
| `webhookSecret` | No | Secret token for webhook verification (required when `webhookUrl` is set) |

```json
{
  "connectors": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groups": {
        "-1001234567890": {
          "requireMention": true
        }
      }
    }
  }
}
```

## Features

- **Private messages** — 1:1 conversations with users
- **Group chats** — Responds in groups when mentioned or replied to
- **Channels** — Can post to Telegram channels
- **Inline queries** — Responds to `@botname query` inline in any chat
- **Media** — Handles photos, documents, audio, video
- **Commands** — Responds to `/command` style messages
- **Webhooks** — Supports webhook mode for production deployments
- **Long polling** — Default mode for development

## Message Flow

```
Telegram Update (via polling or webhook)
       ↓
Plugin processes update type:
  - message → route to AgentRuntime
  - callback_query → handle button press
  - inline_query → handle inline search
       ↓
Determines response target (chat_id)
       ↓
AgentRuntime processes message
       ↓
Response sent via Telegram Bot API
```

## Group Behavior

In group chats, the agent responds only when:

- The bot is mentioned (`@botname`)
- A message is a reply to the bot's message
- The message starts with a configured command

To have the bot respond to all messages in a group, set `allowedGroups` and configure the character to respond more broadly.

## Webhook Mode

For production deployments, webhook mode is more reliable than polling:

```json
{
  "connectors": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "webhookUrl": "https://your-domain.com/webhook/telegram",
      "webhookSecret": "your-random-secret"
    }
  }
}
```

The webhook endpoint must be accessible over HTTPS.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from BotFather |
| `TELEGRAM_API_ROOT` | No | Custom Telegram Bot API root URL |
| `TELEGRAM_ALLOWED_CHATS` | No | Comma-separated list of allowed chat IDs |
| `TELEGRAM_TEST_CHAT_ID` | No | Chat ID for test/dev messages |

## Auto-Enable

The plugin auto-enables when `connectors.telegram.botToken` is set.

## Related

- [Telegram Connector Reference](/connectors/telegram) — Full configuration reference (streaming modes, custom commands, webhook setup, per-group topics, DM history)
- [Discord Plugin](/plugin-registry/platform/discord) — Discord bot integration
- [WhatsApp Plugin](/plugin-registry/platform/whatsapp) — WhatsApp integration
- [Connectors Guide](/guides/connectors) — General connector documentation
