# Zalo Connector

Connect your agent to Zalo for Official Account messaging and support workflows using the `@elizaos/plugin-zalo` package.

A personal-account variant is also available as `@elizaos/plugin-zalouser`.

## Prerequisites

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-zalo` |
| Config key | `connectors.zalo` |
| Install | `eliza plugins install @elizaos/plugin-zalo` |

## Setup

### 1. Create a Zalo Official Account

1. Go to the [Zalo Developers portal](https://developers.zalo.me/)
2. Create an application and obtain your App ID and App Secret
3. Generate an access token and refresh token for API access

### 2. Configure Eliza

| Name | Required | Description |
|------|----------|-------------|
| `ZALO_ACCESS_TOKEN` | Yes | OA access token |
| `ZALO_SECRET_KEY` | Yes | Application secret key |
| `ZALO_APP_ID` | No | Application ID |
| `ZALO_REFRESH_TOKEN` | No | Token refresh credential |
| `ZALO_ENABLED` | No | Enable or disable the connector |
| `ZALO_PROXY_URL` | No | Proxy URL for API requests |
| `ZALO_USE_POLLING` | No | Use polling instead of webhooks |
| `ZALO_WEBHOOK_URL` | No | Webhook URL for inbound messages |
| `ZALO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `ZALO_WEBHOOK_PORT` | No | Webhook listener port |

Install the plugin from the registry:

```bash
eliza plugins install zalo
```

Configure in `~/.eliza/eliza.json`:

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
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZALO_ACCESS_TOKEN` | Yes | OA access token |
| `ZALO_SECRET_KEY` | Yes | Application secret key |
| `ZALO_REFRESH_TOKEN` | No | Token refresh credential |
| `ZALO_APP_ID` | No | Application ID |

## Configuration Reference

| Field | Required | Description |
|-------|----------|-------------|
| `accessToken` | Yes | Zalo API access token |
| `secretKey` | Yes | Zalo application secret key |
| `refreshToken` | No | Zalo API refresh token |
| `appId` | No | Zalo application ID |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Features

- Official Account messaging and support workflows
- Webhook-based message handling
- Polling mode as alternative to webhooks
- Customer interaction management
- Token refresh support

---

## Zalo User (Personal Account)

A separate connector, `@elizaos/plugin-zalouser`, provides personal Zalo account messaging (as opposed to Official Account). Install it with:

```bash
eliza plugins install zalouser
```

### Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-zalouser` |
| Config key | `connectors.zalouser` |
| Category | `connector` |

### Configuration

```json
{
  "connectors": {
    "zalouser": {
      "enabled": true
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZALO_ACCESS_TOKEN` | Yes | OA access token |
| `ZALO_SECRET_KEY` | Yes | Application secret key |
| `ZALO_REFRESH_TOKEN` | No | Token refresh credential |
| `ZALO_APP_ID` | No | Application ID |
| `ZALO_ENABLED` | No | Enable or disable the connector |
| `ZALO_WEBHOOK_URL` | No | Webhook URL for receiving messages |
| `ZALO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `ZALO_WEBHOOK_PORT` | No | Webhook listener port |
| `ZALO_PROXY_URL` | No | Proxy URL for API requests |
| `ZALO_USE_POLLING` | No | Use polling instead of webhooks |

## Features

- Official Account messaging and support workflows
- Webhook-based message handling
- Customer interaction management

## Related

- [Zalo Plugin Reference](/plugin-registry/platform/zalo)
- [Connectors overview](/guides/connectors#zalo)
