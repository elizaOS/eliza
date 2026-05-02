---
title: "Nextcloud Talk Plugin"
sidebarTitle: "Nextcloud Talk"
description: "Nextcloud Talk connector for Eliza — bot integration with Nextcloud Talk chat."
---

The Nextcloud Talk plugin connects Eliza agents to Nextcloud Talk, enabling message handling in Nextcloud Talk conversations on self-hosted Nextcloud instances.

**Package:** `@elizaos/plugin-nextcloud-talk`

## Installation

```bash
eliza plugins install @elizaos/plugin-nextcloud-talk
```

## Setup

### 1. Configure Your Nextcloud Instance

1. Ensure Nextcloud Talk is installed and enabled on your Nextcloud instance
2. Create a bot user or use an existing account for the agent
3. Note the Nextcloud server URL and bot credentials

### 2. Configure Eliza

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

Set credentials via environment variables:

```bash
export NEXTCLOUD_URL=https://your-nextcloud-instance.example.com
export NEXTCLOUD_BOT_SECRET=YOUR_BOT_SECRET
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | No | Set `false` to disable (default: `true`) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXTCLOUD_URL` | Yes | Nextcloud server URL |
| `NEXTCLOUD_BOT_SECRET` | Yes | Bot secret for authentication |
| `NEXTCLOUD_WEBHOOK_HOST` | No | Host address for webhook listener |
| `NEXTCLOUD_WEBHOOK_PORT` | No | Port for webhook listener |
| `NEXTCLOUD_WEBHOOK_PATH` | No | Webhook endpoint path |
| `NEXTCLOUD_WEBHOOK_PUBLIC_URL` | No | Public-facing webhook URL |
| `NEXTCLOUD_ALLOWED_ROOMS` | No | Comma-separated list of allowed room IDs |

## Features

- Room-based messaging
- DM and group conversation support
- Self-hosted collaboration platform integration
- Webhook-based message delivery

## Related

- [Nextcloud Talk Connector Guide](/connectors/nextcloud-talk) — Full connector configuration
- [Connectors Guide](/guides/connectors) — General connector documentation
