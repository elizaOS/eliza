---
title: "Discord Plugin"
sidebarTitle: "Discord"
description: "Discord connector for Eliza — bot integration, slash commands, voice support, and multi-server management."
---

The Discord plugin connects Eliza agents to Discord as a bot, enabling message handling across servers, channels, and DMs with support for slash commands, reactions, and voice channels.

**Package:** `@elizaos/plugin-discord`

## Installation

```bash
eliza plugins install @elizaos/plugin-discord
```

## Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Navigate to **Bot** → **Add Bot**
4. Under **Token**, click **Reset Token** and copy the token
5. Under **Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
   - **Presence Intent**

### 2. Invite the Bot to Your Server

1. Navigate to **OAuth2 → URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Connect` (for voice)
4. Copy the generated URL and open it to invite the bot

### 3. Configure Eliza

```json
{
  "connectors": {
    "discord": {
      "token": "YOUR_BOT_TOKEN"
    }
  }
}
```

Or via environment variables:

```bash
export DISCORD_API_TOKEN=YOUR_BOT_TOKEN
```

The runtime sets both `DISCORD_API_TOKEN` and `DISCORD_BOT_TOKEN` from the configured token, so either variable name works.

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Discord bot token (the Discord config schema uses strict validation — use `token`, not `botToken`) |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `groupPolicy` | No | Group join policy: `"open"`, `"disabled"`, or `"allowlist"` (default: `"allowlist"`) |
| `dm.policy` | No | DM access policy: `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` (default: `"pairing"`) |

```json
{
  "connectors": {
    "discord": {
      "token": "YOUR_BOT_TOKEN",
      "allowedChannels": ["1234567890123456789"],
      "prefix": "!"
    }
  }
}
```

## Features

- **Message handling** — Responds to DMs and channel messages where the bot is mentioned or addressed by name
- **Slash commands** — Registers Discord slash commands for agent actions
- **Reactions** — Can add emoji reactions to messages
- **Threads** — Participates in thread conversations
- **Voice channels** — Can join voice channels (requires additional setup)
- **Multi-server** — Operates across multiple servers simultaneously
- **Role detection** — Reads member roles for permission-based responses

## Message Flow

```
Discord Message
       ↓
Plugin receives MESSAGE_CREATE event
       ↓
Determines if agent should respond:
  - DM → always respond
  - Channel → respond if mentioned or addressed
       ↓
Formats as Eliza Memory
       ↓
AgentRuntime processes
       ↓
Response sent back to Discord channel/DM
```

## Auto-Enable

The plugin auto-enables when the `connectors.discord` block contains a `token` (or `botToken` / `apiKey` — these trigger auto-enable detection but `token` is the validated schema field):

```json
{
  "connectors": {
    "discord": {
      "token": "YOUR_BOT_TOKEN"
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_API_TOKEN` | Yes | Discord bot token |
| `DISCORD_APPLICATION_ID` | No | Discord application ID |
| `CHANNEL_IDS` | No | Comma-separated list of channel IDs to monitor |
| `DISCORD_LISTEN_CHANNEL_IDS` | No | Channel IDs to listen to (alternative to `CHANNEL_IDS`) |
| `DISCORD_TEST_CHANNEL_ID` | No | Channel ID for test/dev messages |
| `DISCORD_VOICE_CHANNEL_ID` | No | Voice channel ID for voice features |
| `DISCORD_SHOULD_IGNORE_BOT_MESSAGES` | No | Ignore messages from other bots |
| `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES` | No | Ignore direct messages |
| `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No | Only respond when @mentioned |

The bot token can also be set via:

Both `DISCORD_API_TOKEN` and `DISCORD_BOT_TOKEN` environment variables are recognized (the runtime sets both for compatibility).

## Related

- [Discord Connector Reference](/connectors/discord) — Full configuration reference (intents, PluralKit, streaming modes, per-guild tools, exec approvals)
- [Telegram Plugin](/plugin-registry/platform/telegram) — Telegram bot integration
- [Slack Plugin](/plugin-registry/platform/slack) — Slack workspace integration
- [Connectors Guide](/guides/connectors) — General connector documentation
