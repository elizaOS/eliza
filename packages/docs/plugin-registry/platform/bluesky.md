---
title: "Bluesky Plugin"
sidebarTitle: "Bluesky"
description: "Bluesky connector for Eliza — post, reply, and interact on the AT Protocol network."
---

The Bluesky plugin connects Eliza agents to the Bluesky social network via the AT Protocol, enabling posting, replying, and social interactions.

**Package:** `@elizaos/plugin-bluesky`

## Installation

This connector auto-enables when its configuration is present in `eliza.json`. You can also install it explicitly:

```bash
eliza plugins install @elizaos/plugin-bluesky
```

## Setup

### 1. Get Your Bluesky Credentials

1. Go to [bsky.app](https://bsky.app) and create an account (or use an existing one)
2. Note your handle (e.g., `yourname.bsky.social`)
3. Use your account username and password (or generate an app password in Settings → App Passwords)

### 2. Configure Eliza

Set the credentials via environment variables in your config:

```json
{
  "env": {
    "BLUESKY_HANDLE": "yourname.bsky.social",
    "BLUESKY_PASSWORD": "YOUR_APP_PASSWORD"
  },
  "connectors": {
    "bluesky": {
      "enabled": true
    }
  }
}
```

Set credentials via environment variables:

```bash
export BLUESKY_HANDLE=yourname.bsky.social
export BLUESKY_PASSWORD=your-app-password
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | No | Set `false` to disable (default: `true`) |
| `postEnable` | No | Enable automated posting |
| `postIntervalMin` | No | Minimum minutes between posts (default: `30`) |
| `postIntervalMax` | No | Maximum minutes between posts (default: `60`) |
| `dryRun` | No | Simulate operations without executing them |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLUESKY_HANDLE` | Yes | Bluesky handle (e.g., `yourname.bsky.social`) |
| `BLUESKY_PASSWORD` | Yes | App password (generate at Settings > App Passwords) |
| `BLUESKY_ENABLED` | No | Set to `true` to enable |
| `BLUESKY_SERVICE` | No | Bluesky PDS instance URL |
| `BLUESKY_DRY_RUN` | No | Set to `true` for testing without posting |
| `BLUESKY_ENABLE_POSTING` | No | Enable or disable post creation |
| `BLUESKY_ENABLE_DMS` | No | Enable direct message processing |
| `BLUESKY_POLL_INTERVAL` | No | Polling interval in seconds |
| `BLUESKY_ENABLE_POSTING` | No | Enable automated posting |
| `BLUESKY_ACTION_INTERVAL` | No | Interval between actions in ms |
| `BLUESKY_MAX_POST_LENGTH` | No | Maximum post length |
| `BLUESKY_POST_IMMEDIATELY` | No | Post immediately on generation |
| `BLUESKY_POST_INTERVAL_MAX` | No | Maximum minutes between posts |
| `BLUESKY_POST_INTERVAL_MIN` | No | Minimum minutes between posts |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | No | Maximum concurrent actions |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | No | Enable processing of actions |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
