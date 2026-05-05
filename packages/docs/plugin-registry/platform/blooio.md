---
title: "Blooio Plugin"
sidebarTitle: "Blooio"
description: "Blooio connector for Eliza — iMessage and SMS messaging via the Blooio bridge service with signed webhooks."
---

The Blooio plugin connects Eliza agents to iMessage and SMS messaging via the Blooio service. Inbound messages are delivered through signed webhooks for security.

**Package:** `@elizaos/plugin-blooio`

> **Note:** Blooio is categorized as a **feature** plugin in the registry, not a connector. It provides platform integration for iMessage/SMS via the Blooio bridge service.

## Installation

```bash
eliza plugins install @elizaos/plugin-blooio
```

## Setup

### 1. Get Blooio Credentials

Obtain an API key from your Blooio account.

### 2. Configure Eliza

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

Or use environment variables:

```bash
export BLOOIO_API_KEY=your-blooio-api-key
export BLOOIO_WEBHOOK_URL=https://your-domain.com/blooio/webhook
```

## Auto-Enable

The plugin auto-enables when `apiKey`, `token`, or `botToken` is present in the connector config.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOOIO_API_KEY` | Yes | Blooio platform API key |
| `BLOOIO_BASE_URL` | No | Base URL for API requests |
| `BLOOIO_FROM_NUMBER` | No | Sender phone number |
| `BLOOIO_WEBHOOK_URL` | No | Public URL for receiving inbound messages |
| `BLOOIO_WEBHOOK_PATH` | No | Webhook endpoint path |
| `BLOOIO_WEBHOOK_PORT` | No | Webhook listener port |
| `BLOOIO_WEBHOOK_SECRET` | No | Secret key for webhook verification |
| `BLOOIO_SIGNATURE_TOLERANCE_SEC` | No | Tolerance window in seconds for signature verification |

## Features

- iMessage and SMS messaging via Blooio bridge
- Signed webhook verification for inbound message security
- Outbound message sending
- Session management and message routing

## Related

- [iMessage Plugin](/plugin-registry/platform/imessage) — Native macOS iMessage (no bridge needed)
- [Connectors Guide](/guides/connectors#blooio) — Full configuration reference
