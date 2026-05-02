# Bluesky Connector

Connect your agent to Bluesky for social posting and engagement on the AT Protocol network using the `@elizaos/plugin-bluesky` package.

## Prerequisites

The Bluesky connector is an elizaOS plugin that bridges your agent to Bluesky via the AT Protocol. It supports automated posting, mention monitoring, and reply handling.

Unlike the 18 auto-enabled connectors (Discord, Telegram, etc.), Bluesky is a **registry plugin** that must be installed manually before use. It is not auto-enabled from connector config alone.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-bluesky` |
| Config key | `connectors.bluesky` |
| Install | `eliza plugins install @elizaos/plugin-bluesky` |

## Setup Requirements

- Bluesky account credentials (handle and app password)
- Generate an app password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `BLUESKY_HANDLE` | Yes | Bluesky handle (e.g., `yourname.bsky.social`) |
| `BLUESKY_PASSWORD` | Yes | App password (not your main password -- generate at bsky.app/settings/app-passwords) |
| `BLUESKY_ENABLED` | No | Enable or disable the plugin (default: `true`) |
| `BLUESKY_SERVICE` | No | Bluesky PDS instance URL (default: `https://bsky.social`) |
| `BLUESKY_DRY_RUN` | No | Set to `true` for testing without posting (default: `false`) |
| `BLUESKY_ENABLE_POSTING` | No | Enable or disable post creation (default: `true`) |
| `BLUESKY_ENABLE_DMS` | No | Enable processing of direct messages via the chat.bsky API (default: `true`) |
| `BLUESKY_POLL_INTERVAL` | No | Polling interval in seconds for fetching notifications (default: `60`) |
| `BLUESKY_ACTION_INTERVAL` | No | Interval in seconds between action-processing cycles (default: `120`) |
| `BLUESKY_MAX_POST_LENGTH` | No | Maximum characters per post (default: `300`) |
| `BLUESKY_POST_IMMEDIATELY` | No | Post immediately instead of waiting for schedule (default: `false`) |
| `BLUESKY_POST_INTERVAL_MIN` | No | Minimum interval in seconds between automated posts (default: `1800`) |
| `BLUESKY_POST_INTERVAL_MAX` | No | Maximum interval in seconds between automated posts (default: `3600`) |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | No | Maximum actions to process in a single batch (default: `5`) |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | No | Enable automated action processing (default: `true`) |

Install the plugin from the registry:

```bash
eliza plugins install bluesky
```

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true
    }
  }
}
```

## Setup

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BLUESKY_HANDLE` | Yes | — | Bluesky handle (e.g., `yourname.bsky.social`) |
| `BLUESKY_PASSWORD` | Yes | — | App password (not your main password -- generate at bsky.app/settings/app-passwords) |
| `BLUESKY_ENABLED` | No | `true` | Set to `true` to enable |
| `BLUESKY_SERVICE` | No | `https://bsky.social` | Bluesky PDS instance URL |
| `BLUESKY_DRY_RUN` | No | `false` | Set to `true` for testing without posting |
| `BLUESKY_ENABLE_POSTING` | No | `true` | Enable or disable post creation |
| `BLUESKY_ENABLE_DMS` | No | `true` | Enable processing of direct messages via the chat.bsky API |
| `BLUESKY_POLL_INTERVAL` | No | `60` | Polling interval in seconds |
| `BLUESKY_ACTION_INTERVAL` | No | `120` | Interval in seconds between action-processing cycles |
| `BLUESKY_MAX_POST_LENGTH` | No | `300` | Maximum characters allowed in a post |
| `BLUESKY_POST_IMMEDIATELY` | No | `false` | Publish posts immediately instead of waiting for the schedule |
| `BLUESKY_POST_INTERVAL_MIN` | No | `1800` | Minimum interval in seconds between automated posts |
| `BLUESKY_POST_INTERVAL_MAX` | No | `3600` | Maximum interval in seconds between automated posts |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | No | `5` | Maximum actions to process in a single batch |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | No | `true` | Enable automated action processing for events |

## Features

- Post creation at configurable intervals
- Mention and reply monitoring
- Direct message handling via chat.bsky API
- Action processing (likes, reposts)
- Dry run mode for testing
- AT Protocol-based decentralized social networking

## Related

- [Bluesky plugin reference](/plugin-registry/platform/bluesky)
- [Connectors overview](/guides/connectors#bluesky)
