---
title: "WeChat Plugin"
sidebarTitle: "WeChat"
description: "The @elizaos/plugin-wechat package is not currently available in the Eliza plugin registry."
---

<Warning>
The WeChat plugin is maintained locally in this repository under `packages/plugin-wechat/` and is not published to the elizaOS plugin registry. It is available as a workspace dependency.
</Warning>

The WeChat plugin connects Eliza agents to WeChat via a user-supplied proxy service, enabling text messaging and optional image and group chat support from personal WeChat accounts.

> **Availability:** `@elizaos/plugin-wechat` is a Eliza-local plugin that is **not** included in the bundled `plugins.json` registry. It ships as a CI stub and requires the full plugin package to be available locally or via npm.

**Package:** `@elizaos/plugin-wechat`

> **Availability:** This plugin is not in the bundled registry (`plugins.json`). It is available as an upstream elizaOS plugin and auto-enables when its connector config is present.

## Overview

Unlike most connectors which use official platform APIs, the WeChat connector relied on a third-party proxy service that bridges WeChat's protocol.

**Privacy Notice:** The WeChat connector sends your API key and message payloads through the configured proxy service. Only point `proxyUrl` at infrastructure you operate yourself or explicitly trust.

## Installation (unavailable)

<Warning>
The WeChat plugin is **experimental** and not yet included in the Eliza bundled plugin registry. Full integration is in progress.
</Warning>

The WeChat plugin (`@elizaos/plugin-wechat`) is not yet available in the bundled registry. Check the [changelog](/changelog) for availability updates.

## Setup

### 1. Obtain a Proxy API Key

Get an API key from your WeChat proxy service provider.

### 2. Configure Eliza

```json
{
  "connectors": {
    "wechat": {
      "apiKey": "YOUR_API_KEY",
      "proxyUrl": "https://your-proxy-service.example.com"
    }
  }
}
```

Or set the environment variable:

```bash
export WECHAT_API_KEY=YOUR_API_KEY
```

### 3. Scan the QR Code

On first start, the plugin displays a QR code in the terminal. Scan it with WeChat on your phone to link the session.

## Configuration

### Single Account

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `apiKey` | Yes | — | Proxy service API key |
| `proxyUrl` | Yes | — | Proxy service URL |
| `webhookPort` | No | `18790` | Webhook listener port for incoming messages |
| `deviceType` | No | `"ipad"` | Device emulation type: `"ipad"` or `"mac"` |
| `enabled` | No | `true` | Enable or disable the connector |
| `features.images` | No | `false` | Enable image send/receive |
| `features.groups` | No | `false` | Enable group chat support |

```json
{
  "connectors": {
    "wechat": {
      "apiKey": "YOUR_API_KEY",
      "proxyUrl": "https://your-proxy.example.com",
      "webhookPort": 18790,
      "deviceType": "ipad",
      "features": {
        "images": true,
        "groups": true
      }
    }
  }
}
```

### Multi-Account Support

Run multiple WeChat accounts using the `accounts` map:

```json
{
  "connectors": {
    "wechat": {
      "accounts": {
        "personal": {
          "apiKey": "KEY_1",
          "proxyUrl": "https://proxy.example.com",
          "deviceType": "ipad"
        },
        "work": {
          "apiKey": "KEY_2",
          "proxyUrl": "https://proxy.example.com",
          "deviceType": "mac",
          "enabled": false
        }
      },
      "features": {
        "groups": true
      }
    }
  }
}
```

Each account has its own API key, proxy URL, and session. Per-account fields override top-level settings.

## Features

- **Text messaging** — DM conversations enabled by default
- **Group chats** — Participate in group conversations (enable with `features.groups: true`)
- **Image support** — Send and receive images (enable with `features.images: true`)
- **QR code login** — Authenticate by scanning a QR code, with automatic session persistence
- **Multi-account** — Run multiple WeChat accounts from a single agent
- **Device emulation** — Choose between iPad or Mac client emulation
- **Health checks** — Automatic periodic health checks with reconnection on failure

## Message Flow

```
Proxy webhook delivers incoming message
       ↓
Plugin filters by message type and features config
       ↓
AgentRuntime processes the message
       ↓
Response sent via proxy API
```

## Auto-Enable

The plugin auto-enables when `connectors.wechat` contains:
- A top-level `apiKey`, OR
- An `accounts` map with at least one enabled account that has an `apiKey`

Setting `enabled: false` at the connector or account level disables auto-enable.

## Supported Message Types

The plugin handles these incoming message types:

| Type | Description |
|------|-------------|
| `text` | Plain text messages |
| `image` | Image attachments (requires `features.images`) |
| `video` | Video messages |
| `file` | File attachments |
| `voice` | Voice messages |

## Troubleshooting

### QR Code Not Displaying

Ensure the proxy service URL is reachable and the API key is valid. The plugin logs errors to the console if the proxy returns an error during login.

### Session Expired

WeChat sessions can expire after extended inactivity. The plugin automatically attempts to re-login. If re-login fails, a new QR code is displayed for scanning.

### Messages Not Arriving

- Check that the `webhookPort` (default: 18790) is not blocked by a firewall
- Verify `features.groups` is enabled if you expect group messages
- Confirm the proxy service is running and forwarding webhooks

## Related

- [Connectors Overview](/guides/connectors) — All connector options
- [Telegram Plugin](/plugin-registry/platform/telegram) — Telegram bot integration
- [WhatsApp Plugin](/plugin-registry/platform/whatsapp) — WhatsApp integration via Baileys
