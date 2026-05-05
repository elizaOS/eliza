# Blooio Connector

Connect your agent to iMessage and SMS messaging via the Blooio bridge service using the `@elizaos/plugin-blooio` package.

> **Note:** Blooio is registered as a **feature** plugin (not a connector) in the plugin registry. It behaves like a connector but is categorized under features in `plugins.json`.

## Overview

- A Blooio account and API key from the Blooio platform

<Note>
In the bundled registry (`plugins.json`) this plugin is listed under the `feature` category rather than `connector`. It functions as a connector regardless of the registry classification.
</Note>

## Package Info

| Name | Required | Description |
|------|----------|-------------|
| `BLOOIO_API_KEY` | Yes | Blooio service API key |
| `BLOOIO_BASE_URL` | No | Base URL for API requests |
| `BLOOIO_FROM_NUMBER` | No | Sender phone number |
| `BLOOIO_WEBHOOK_URL` | No | Webhook callback URL for receiving inbound messages |
| `BLOOIO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `BLOOIO_WEBHOOK_PORT` | No | Webhook listener port |
| `BLOOIO_WEBHOOK_SECRET` | No | Secret key for webhook/client verification |
| `BLOOIO_SIGNATURE_TOLERANCE_SEC` | No | Tolerance window in seconds for signature validation |

These can be set as environment variables or under the `connectors.blooio` config in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "blooio": {
      "apiKey": "YOUR_BLOOIO_API_KEY"
    }
  }
}
```

The connector auto-enables when `apiKey` is truthy in the connector config and `enabled` is not explicitly `false`.

To disable:

```json
{
  "connectors": {
    "blooio": {
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "enabled": false
    }
  }
}
```

## Setup

1. Obtain an API key from the Blooio platform.
2. Add it to `connectors.blooio` in your config or set the `BLOOIO_API_KEY` environment variable.
3. Start your agent -- the Blooio connector will auto-enable.

No environment variable is required to trigger auto-enable — it is driven entirely by the connector config object.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOOIO_API_KEY` | Yes | Blooio service API key |
| `BLOOIO_WEBHOOK_URL` | No | URL for receiving inbound messages |
| `BLOOIO_BASE_URL` | No | Base URL for API requests |
| `BLOOIO_PHONE_NUMBER` | No | Sender phone number (injected by the runtime from `fromNumber` config field) |
| `BLOOIO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `BLOOIO_WEBHOOK_PORT` | No | Webhook listener port |
| `BLOOIO_WEBHOOK_SECRET` | No | Secret key for webhook/client verification |
| `BLOOIO_SIGNATURE_TOLERANCE_SEC` | No | Tolerance window in seconds for webhook signature verification |

## Setup Steps

1. Obtain an API key from the Blooio platform
2. Add it to `connectors.blooio` in your config or set the `BLOOIO_API_KEY` environment variable
3. Start your agent — the Blooio connector will auto-enable

## Full Configuration Reference

All fields are defined under `connectors.blooio` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | — | Blooio API key (required) |
| `webhookUrl` | string | — | Webhook URL for receiving inbound messages |
| `baseUrl` | string | — | Base URL for API requests |
| `fromNumber` | string | — | Sender phone number |
| `webhookPath` | string | — | Webhook endpoint path |
| `webhookPort` | number | — | Webhook listener port |
| `webhookSecret` | string | — | Secret key for webhook/client verification |
| `enabled` | boolean | — | Explicitly enable/disable |

### Features

- iMessage and SMS messaging via the Blooio bridge
- Signed webhook verification for inbound messages
- Outbound message sending via API

## Related

- [Blooio plugin reference](/plugin-registry/platform/blooio)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
