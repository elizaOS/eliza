# Mattermost Connector

Connect your agent to a self-hosted Mattermost server for channel and DM conversations using the `@elizaos/plugin-mattermost` package.

## Prerequisites

- A Mattermost server with bot account support enabled
- A bot token from the Mattermost System Console

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `MATTERMOST_BOT_TOKEN` | Yes | Bot token from Mattermost System Console |
| `MATTERMOST_SERVER_URL` | No | Server URL for the Mattermost instance |
| `MATTERMOST_ENABLED` | No | Enable or disable the connector |
| `MATTERMOST_TEAM_ID` | No | Team/tenant ID to restrict the bot to |
| `MATTERMOST_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `MATTERMOST_GROUP_POLICY` | No | Group message policy (e.g., `allow`, `deny`) |
| `MATTERMOST_ALLOWED_USERS` | No | Comma-separated allowed user list |
| `MATTERMOST_ALLOWED_CHANNELS` | No | Comma-separated allowed channel list |
| `MATTERMOST_REQUIRE_MENTION` | No | Only respond when @mentioned |
| `MATTERMOST_IGNORE_BOT_MESSAGES` | No | Ignore messages from other bots |

The connector auto-enables when `botToken` is truthy in the connector config and `enabled` is not explicitly `false`.

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "mattermost": {
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com"
    }
  }
}
```

To disable:

```json
{
  "connectors": {
    "mattermost": {
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com",
      "enabled": false
    }
  }
}
```

## Setup

1. In Mattermost System Console, create a bot account and note the bot token.
2. Add the bot token and server URL to `connectors.mattermost` in your config.
3. Start your agent -- the Mattermost connector will auto-enable.

## Features

## Environment Variables

When the connector is loaded, the runtime pushes the following secrets from your config into `process.env` for the plugin to consume:

| Variable | Required | Description |
|----------|----------|-------------|
| `MATTERMOST_BOT_TOKEN` | Yes | Bot token from Mattermost System Console |
| `MATTERMOST_SERVER_URL` | No | Server URL for the Mattermost server |
| `MATTERMOST_ENABLED` | No | Enable or disable the connector |
| `MATTERMOST_TEAM_ID` | No | Team ID to restrict the bot to |
| `MATTERMOST_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `MATTERMOST_GROUP_POLICY` | No | Group message policy |
| `MATTERMOST_ALLOWED_USERS` | No | Comma-separated allowed user list |
| `MATTERMOST_ALLOWED_CHANNELS` | No | Comma-separated channel list to restrict the bot to |
| `MATTERMOST_REQUIRE_MENTION` | No | Only respond when @mentioned |
| `MATTERMOST_IGNORE_BOT_MESSAGES` | No | Ignore messages from other bots |

## Full Configuration Reference

All fields are defined under `connectors.mattermost` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `botToken` | string | — | Bot token from Mattermost System Console (required) |
| `baseUrl` | string | — | Base URL for your Mattermost server (required) |
| `enabled` | boolean | — | Explicitly enable/disable |
| `chatmode` | `"dm-only"` \| `"channel-only"` \| `"all"` | `"all"` | Restrict which chat types the bot responds in |
| `requireMention` | boolean | `false` | Only respond when @mentioned |
| `oncharPrefixes` | string[] | — | Custom command prefixes that trigger agent responses |
| `configWrites` | boolean | `true` | Allow config writes from channel events |

### Chat Mode

The `chatmode` field controls where the bot responds:

| Mode | Behavior |
|------|----------|
| `"all"` | Responds in both DMs and channels (default) |
| `"dm-only"` | Responds only in direct messages |
| `"channel-only"` | Responds only in channels |

```json
{
  "connectors": {
    "mattermost": {
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com",
      "chatmode": "all",
      "requireMention": true,
      "oncharPrefixes": ["!", "/ask"]
    }
  }
}
```

### Self-Hosted Server Support

The Mattermost connector works with any Mattermost server deployment, including self-hosted instances. Set `baseUrl` to your server's URL and ensure the Eliza host can reach it over the network.

## Multi-Account Support

Mattermost does not support multi-account configuration. Each agent runs a single Mattermost bot.

## Related

- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
