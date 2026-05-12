---
title: "Zalo Plugin"
sidebarTitle: "Zalo"
description: "Zalo connector for Eliza — bot integration with the Zalo messaging platform."
---

The Zalo plugin connects Eliza agents to Zalo, enabling message handling through the Zalo Official Account API.

**Package:** `@elizaos/plugin-zalo`

## Installation

```bash
eliza plugins install @elizaos/plugin-zalo
```

## Setup

### 1. Create a Zalo Official Account

1. Go to the [Zalo Developers portal](https://developers.zalo.me/)
2. Create an application and obtain your App ID and App Secret
3. Generate an access token and refresh token for API access

### 2. Configure Eliza

```json
{
  "connectors": {
    "zalo": {
      "accessToken": "YOUR_ACCESS_TOKEN",
      "secretKey": "YOUR_SECRET_KEY",
      "refreshToken": "YOUR_REFRESH_TOKEN",
      "appId": "YOUR_APP_ID"
    }
  }
}
```

Or via environment variables:

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_SECRET_KEY=YOUR_SECRET_KEY
export ZALO_APP_ID=YOUR_APP_ID
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `accessToken` | Yes | Zalo API access token |
| `secretKey` | Yes | Zalo application secret key |
| `appId` | No | Zalo application ID |
| `refreshToken` | No | Token refresh credential |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZALO_ACCESS_TOKEN` | Yes | Zalo API access token (primary auto-enable trigger) |
| `ZALO_SECRET_KEY` | Yes | Zalo application secret key |
| `ZALO_REFRESH_TOKEN` | No | Zalo API refresh token |
| `ZALO_APP_ID` | No | Zalo application ID |
| `ZALO_ENABLED` | No | Enable or disable the connector |
| `ZALO_PROXY_URL` | No | Proxy URL for API requests |
| `ZALO_USE_POLLING` | No | Use polling instead of webhooks |
| `ZALO_WEBHOOK_URL` | No | Webhook callback URL |
| `ZALO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `ZALO_WEBHOOK_PORT` | No | Webhook listener port |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
