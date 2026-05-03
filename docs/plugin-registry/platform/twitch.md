---
title: "Twitch Plugin"
sidebarTitle: "Twitch"
description: "Twitch connector for Eliza — channel chat messaging and interaction."
---

The Twitch plugin connects Eliza agents to Twitch, enabling chat messaging and channel interaction.

**Package:** `@elizaos/plugin-twitch`

## Installation

```bash
eliza plugins install @elizaos/plugin-twitch
```

## Setup

### 1. Create a Twitch Application

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console/apps)
2. Create a new application
3. Note the **Client ID**
4. Generate an **Access Token** with the required chat scopes

### 2. Configure Eliza

```json
{
  "connectors": {
    "twitch": {
      "accessToken": "your-twitch-access-token",
      "clientId": "your-twitch-client-id"
    }
  }
}
```

Or use environment variables:

```bash
export TWITCH_ACCESS_TOKEN=your-twitch-access-token
export TWITCH_CLIENT_ID=your-twitch-client-id
```

## Auto-Enable

The plugin auto-enables when any of these are present:

- `accessToken` in connector config
- `clientId` in connector config
- `enabled: true` in connector config

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `accessToken` | Yes* | Twitch OAuth access token |
| `clientId` | Yes* | Twitch application Client ID |
| `clientSecret` | No | Twitch client secret |
| `refreshToken` | No | Refresh token for token renewal |
| `username` | No | Twitch username for the bot |
| `channel` | No | Primary channel name to join |
| `channels` | No | Additional channel names to join |
| `requireMention` | No | Only respond when mentioned |
| `allowedRoles` | No | Comma-separated allowed roles |
| `enabled` | No | Force-enable without credentials |

\* At least one of `accessToken`, `clientId`, or `enabled: true` is required.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWITCH_ACCESS_TOKEN` | Yes | Twitch OAuth access token (primary auto-enable trigger) |
| `TWITCH_CLIENT_ID` | No | Twitch application Client ID |
| `TWITCH_CLIENT_SECRET` | No | Twitch client secret |
| `TWITCH_REFRESH_TOKEN` | No | Refresh token for token renewal |
| `TWITCH_USERNAME` | No | Twitch username for the bot |
| `TWITCH_CHANNEL` | No | Primary channel name to join |
| `TWITCH_CHANNELS` | No | Additional channel names to join |
| `TWITCH_ALLOWED_ROLES` | No | Comma-separated allowed roles |
| `TWITCH_REQUIRE_MENTION` | No | Only respond when mentioned |

## Features

- Channel chat messaging
- Whisper / DM support
- Chat event handling

## Streaming

For live-streaming output to Twitch, enable **`@elizaos/plugin-streaming`** and set `TWITCH_STREAM_KEY` (and optional `streaming.twitch` in config). See [Streaming](/skills/streaming) for setup details.
