# WeChat Connector

Connect your agent to WeChat for personal and group messaging via a third-party proxy service using the `@elizaos/plugin-wechat` package.

> **Status:** The `@elizaos/plugin-wechat` package is not currently available in the plugin registry. This page documents the planned connector interface. Check the [plugin registry](/plugins/registry) for availability updates.

<Warning>
This connector is **not included** in the bundled plugin registry (`plugins.json`). It is a Eliza-specific plugin that must be installed separately. Run `bun run setup:upstreams` to make it available from the local checkout.
</Warning>

<Warning>
The `@elizaos/plugin-wechat` package is not included in the bundled plugin registry (`plugins.json`). It may be available as an upstream elizaOS plugin. Install it manually from npm if available.
</Warning>

> **Availability:** `@elizaos/plugin-wechat` is a Eliza-local plugin that is **not** included in the bundled `plugins.json` registry. It ships as a CI stub and requires the full plugin package to be available locally or via npm.

## Overview

The WeChat connector is a plugin that bridges your agent to WeChat via a user-supplied proxy service. Unlike most connectors which use official platform APIs, the WeChat connector relies on a third-party proxy that bridges WeChat's protocol. Your agent authenticates by scanning a QR code displayed in the terminal on first startup.

- A WeChat account
- A proxy service URL and API key for bridging WeChat's protocol

> **Privacy notice:** The WeChat connector sends your API key and message payloads through the configured proxy service. Only point `proxyUrl` at infrastructure you operate yourself or explicitly trust for that message flow.

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `WECHAT_API_KEY` | Yes | Proxy service API key |

Additional configuration is done via the `connectors.wechat` config in `~/.eliza/eliza.json`:

| Config Field | Type | Default | Description |
|------|------|---------|-------------|
| `apiKey` | string | -- | Proxy service API key (required) |
| `proxyUrl` | string | -- | Proxy service URL (required) |
| `webhookPort` | number | `18790` | Webhook listener port |
| `deviceType` | `"ipad"` / `"mac"` | `"ipad"` | Device emulation type |
| `enabled` | boolean | -- | Explicitly enable/disable |
| `features.images` | boolean | `false` | Enable image send/receive |
| `features.groups` | boolean | `false` | Enable group chat support |

The connector auto-enables when `apiKey` is truthy at the top level, or an `accounts` entry has a truthy `apiKey`.

Configure in `~/.eliza/eliza.json`:

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

## Disabling

To explicitly disable the connector even when an API key is present:

```json
{
  "connectors": {
    "wechat": {
      "apiKey": "YOUR_API_KEY",
      "proxyUrl": "https://your-proxy-service.example.com",
      "enabled": false
    }
  }
}
```

## Setup

1. Obtain an API key and proxy service URL.
2. Add the credentials to `connectors.wechat` in your config.
3. Start Eliza -- on first start, the plugin displays a QR code in the terminal.
4. Scan the QR code with WeChat on your phone to link the session.
5. Sessions persist automatically -- subsequent starts reuse the existing session unless it has expired.

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
- **Multi-account** — Run multiple WeChat accounts from a single agent via the `accounts` map
- **Device emulation** — Choose between iPad or Mac client emulation

## Related

- [WeChat plugin reference](/plugin-registry/platform/wechat)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
