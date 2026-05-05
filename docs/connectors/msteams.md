# Microsoft Teams Connector

Connect your agent to Microsoft Teams for DMs, team channels, and threaded conversations using the `@elizaos/plugin-msteams` package.

## Prerequisites

- An Azure Bot registration with App ID, App Password, and Tenant ID
- The bot registered in the Microsoft Teams admin center

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `MSTEAMS_APP_PASSWORD` | Yes | Azure Bot App Password (client secret) |
| `MSTEAMS_APP_ID` | No | Azure Bot App ID (Microsoft App ID) |
| `MSTEAMS_TENANT_ID` | No | Azure AD Tenant ID |
| `MSTEAMS_ENABLED` | No | Enable or disable the connector |
| `MSTEAMS_WEBHOOK_PATH` | No | Webhook endpoint path |
| `MSTEAMS_WEBHOOK_PORT` | No | Port for incoming webhook events |
| `MSTEAMS_MEDIA_MAX_MB` | No | Maximum media file size in MB |
| `MSTEAMS_ALLOWED_TENANTS` | No | Comma-separated allowed tenant list |
| `MSTEAMS_SHAREPOINT_SITE_ID` | No | SharePoint site ID for file uploads in group chats |

The connector auto-enables when `botToken`, `token`, or `apiKey` is truthy in the connector config. The `appId`/`appPassword`/`tenantId` fields alone do not trigger auto-enable -- you must include one of the trigger fields or add the plugin to `plugins.allow`.

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "msteams": {
      "botToken": "YOUR_BOT_TOKEN",
      "appId": "YOUR_APP_ID",
      "appPassword": "YOUR_APP_PASSWORD",
      "tenantId": "YOUR_TENANT_ID"
    }
  }
}
```

If you don't have a `botToken`, add the plugin explicitly:

```json
{
  "plugins": {
    "allow": ["@elizaos/plugin-msteams"]
  },
  "connectors": {
    "msteams": {
      "appId": "YOUR_APP_ID",
      "appPassword": "YOUR_APP_PASSWORD",
      "tenantId": "YOUR_TENANT_ID"
    }
  }
}
```

To disable:

```json
{
  "connectors": {
    "msteams": {
      "enabled": false
    }
  }
}
```

## Setup

1. Register an Azure Bot in the [Azure Portal](https://portal.azure.com).
2. Note the **App ID**, **App Password** (client secret), and **Tenant ID**.
3. Configure the bot's messaging endpoint to point to your Eliza instance.
4. Add the bot to Microsoft Teams via the Teams admin center.
5. Add the credentials to your Eliza config.
6. Start your agent.

## Features

## Environment Variables

When the connector is loaded, the runtime can consume the following secrets from environment variables as an alternative to inline config:

| Variable | Required | Description |
|----------|----------|-------------|
| `MSTEAMS_APP_ID` | No | Azure Bot App ID |
| `MSTEAMS_APP_PASSWORD` | Yes | Azure Bot App Password (client secret) |
| `MSTEAMS_TENANT_ID` | No | Azure AD Tenant ID |
| `MSTEAMS_ENABLED` | No | Enable or disable the connector |
| `MSTEAMS_WEBHOOK_PATH` | No | Webhook endpoint path |
| `MSTEAMS_WEBHOOK_PORT` | No | Port for incoming webhook events |
| `MSTEAMS_MEDIA_MAX_MB` | No | Maximum media file size in MB |
| `MSTEAMS_ALLOWED_TENANTS` | No | Comma-separated list of allowed tenant IDs |
| `MSTEAMS_SHAREPOINT_SITE_ID` | No | SharePoint site ID for file uploads in group chats |

## Full Configuration Reference

All fields are defined under `connectors.msteams` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `appId` | string | — | Azure Bot App ID (Microsoft App ID) |
| `appPassword` | string | — | Azure Bot App Password (client secret) |
| `tenantId` | string | — | Azure AD Tenant ID |
| `enabled` | boolean | — | Explicitly enable/disable |
| `capabilities` | string[] | — | Capability flags |
| `configWrites` | boolean | — | Allow config writes from Teams events |
| `requireMention` | boolean | — | Only respond when @mentioned |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy. `"open"` requires `allowFrom` to include `"*"` |
| `allowFrom` | string[] | — | User IDs allowed to DM |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group join policy |
| `groupAllowFrom` | string[] | — | Allowed group/team IDs |
| `historyLimit` | integer >= 0 | — | Max messages in context |
| `dmHistoryLimit` | integer >= 0 | — | History limit for DMs |
| `dms` | object | — | Per-DM history overrides keyed by DM ID. Each value: `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | Long message splitting strategy |
| `mediaMaxMb` | number > 0 | — | Max media file size in MB (up to 100MB via OneDrive upload) |
| `blockStreamingCoalesce` | object | — | Coalescing settings: `minChars`, `maxChars`, `idleMs` |
| `replyStyle` | `"thread"` \| `"top-level"` | `"thread"` | Reply threading mode |
| `markdown` | object | — | Table rendering: `tables` can be `"off"`, `"bullets"`, or `"code"` |

### Webhook Configuration

| Field | Type | Description |
|-------|------|-------------|
| `webhook.port` | integer > 0 | Port for incoming webhook events |
| `webhook.path` | string | Path for webhook endpoint (e.g., `/api/msteams/webhook`) |

### Media Configuration

| Field | Type | Description |
|-------|------|-------------|
| `mediaAllowHosts` | string[] | Allowlist of hosts from which media can be downloaded |
| `mediaAuthAllowHosts` | string[] | Hosts that require authentication headers for media downloads |
| `sharePointSiteId` | string | SharePoint site ID for file uploads in group chats (e.g., `"contoso.sharepoint.com,guid1,guid2"`) |

### Team Configuration

Per-team settings are defined under `teams.<team-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `requireMention` | boolean | Only respond when @mentioned |
| `tools` | ToolPolicySchema | Tool access policy |
| `toolsBySender` | object | Per-sender tool policies (keyed by sender ID) |
| `replyStyle` | `"thread"` \| `"top-level"` | Override reply style for this team |
| `channels` | object | Per-channel configuration (see below) |

### Channel Configuration

Per-channel settings are defined within a team under `teams.<team-id>.channels.<channel-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `requireMention` | boolean | Only respond when @mentioned |
| `tools` | ToolPolicySchema | Tool access policy |
| `toolsBySender` | object | Per-sender tool policies (keyed by sender ID) |
| `replyStyle` | `"thread"` \| `"top-level"` | Override reply style for this channel |

### Heartbeat

```json
{
  "connectors": {
    "msteams": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

## Related

- [Google Chat connector](/connectors/googlechat)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
