---
title: "Microsoft Teams Plugin"
sidebarTitle: "MS Teams"
description: "Microsoft Teams connector for Eliza — Azure Bot integration with per-team configuration, threaded replies, and media support up to 100MB."
---

The Microsoft Teams plugin connects Eliza agents to Teams as an Azure Bot, supporting channel messages, DMs, threaded replies, and media uploads via OneDrive/SharePoint.

**Package:** `@elizaos/plugin-msteams`

## Installation

```bash
eliza plugins install @elizaos/plugin-msteams
```

## Setup

### 1. Register an Azure Bot

1. Go to the [Azure Portal](https://portal.azure.com)
2. Create a new **Bot Channels Registration** or **Azure Bot** resource
3. Note the **App ID** (Microsoft App ID)
4. Under **Configuration**, create a new **App Password** (client secret)
5. Note the **Tenant ID** from Azure Active Directory

### 2. Configure Bot Messaging Endpoint

Set the messaging endpoint to your Eliza server URL:

```
https://your-eliza-host/api/msteams/webhook
```

### 3. Configure Eliza

```json
{
  "connectors": {
    "msteams": {
      "enabled": true,
      "appId": "YOUR_APP_ID",
      "appPassword": "YOUR_APP_PASSWORD",
      "tenantId": "YOUR_TENANT_ID",
      "dmPolicy": "pairing"
    }
  }
}
```

Or via environment variables:

```bash
export MSTEAMS_APP_ID=YOUR_APP_ID
export MSTEAMS_APP_PASSWORD=YOUR_APP_PASSWORD
export MSTEAMS_TENANT_ID=YOUR_TENANT_ID
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `appId` | Yes | Azure Bot App ID |
| `appPassword` | Yes | Azure Bot App Password (client secret) |
| `tenantId` | Yes | Azure AD Tenant ID |
| `replyStyle` | No | `thread` or `top-level` (default: `thread`) |
| `webhookPort` | No | Port for incoming webhooks |
| `webhookPath` | No | Path for webhook endpoint |
| `mediaHostAllowlist` | No | Allowed hosts for media downloads |
| `mediaAuthHosts` | No | Hosts requiring auth for media downloads |
| `sharepointSiteId` | No | SharePoint site ID for file uploads in group chats |
| `dmPolicy` | No | DM handling policy |
| `allowFrom` | No | Array of allowed user IDs (for open DM policy) |

## Features

- **Channel messages** — Responds to @mentions in team channels
- **DMs** — Full private conversation support
- **Threaded replies** — Configurable thread vs top-level reply style
- **Per-team configuration** — Override settings per team and per channel
- **Media support** — Upload files up to 100MB via OneDrive integration
- **SharePoint integration** — File uploads in group chats via SharePoint site
- **Media host allowlists** — Control which hosts can serve downloadable media

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MSTEAMS_APP_ID` | No | Azure Bot App ID |
| `MSTEAMS_ENABLED` | No | Enable or disable the connector |
| `MSTEAMS_TENANT_ID` | No | Azure AD Tenant ID |
| `MSTEAMS_APP_PASSWORD` | Yes | Azure Bot App Password (client secret) |
| `MSTEAMS_MEDIA_MAX_MB` | No | Maximum media upload size in MB |
| `MSTEAMS_WEBHOOK_PATH` | No | Webhook endpoint path |
| `MSTEAMS_WEBHOOK_PORT` | No | Webhook listener port |
| `MSTEAMS_ALLOWED_TENANTS` | No | Comma-separated allowed tenant IDs |
| `MSTEAMS_SHAREPOINT_SITE_ID` | No | SharePoint site ID for file uploads |

## Auto-Enable

The plugin auto-enables when the `connectors.msteams` block contains `botToken`, `token`, or `apiKey`. Note that `appId` and `appPassword` alone do not trigger auto-enable -- set `botToken` to the app password to trigger auto-enable, or add the plugin to `plugins.allow` explicitly.

## Troubleshooting

### Bot Not Responding

Verify the messaging endpoint URL is publicly accessible and points to your Eliza server's webhook path.

### Authentication Errors

Ensure the App Password has not expired. Azure Bot client secrets have configurable expiry periods.

## Related

- [Slack Plugin](/plugin-registry/platform/slack) — Slack workspace integration
- [Google Chat Plugin](/plugin-registry/platform/googlechat) — Google Chat integration
- [Connectors Guide](/guides/connectors) — General connector documentation
