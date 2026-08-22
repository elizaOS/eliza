# @elizaos/plugin-wechat

WeChat connector plugin for [elizaOS](https://github.com/elizaOS/eliza) via proxy API.

Adds WeChat DM and group messaging to an Eliza agent. The plugin connects to a
third-party WeChat proxy service, starts a local webhook server to receive
inbound messages, and registers a `MessageConnector` so the agent can send/
receive text and images, resolve contacts, and read chat history.

## Features

- Text and image messaging (DM and group)
- Multi-account support
- QR-code login flow (prints URL to terminal; scan with WeChat mobile)
- Webhook-based inbound message delivery with deduplication
- Automatic session health checks and re-login on expiry

## Install

```bash
npx elizaos plugins add @elizaos/plugin-wechat
```

## Configuration

### Environment variables (single-account)

| Env Var | Required | Description |
|---|---|---|
| `WECHAT_API_KEY` | Yes | Proxy service API key |
| `WECHAT_PROXY_URL` | Yes | Base URL of the WeChat proxy (`https://`; literal loopback HTTP is reserved for local protocol simulators) |
| `ELIZA_WECHAT_WEBHOOK_PORT` | No | Webhook listener port (default: `18790`) |

### Character config block (recommended)

```jsonc
{
  "connectors": {
    "wechat": {
      "apiKey": "YOUR_API_KEY",
      "proxyUrl": "https://your-proxy.example.com",
      "webhookPort": 18790,
      "deviceType": "ipad",
      "loginTimeoutMs": 300000,
      "features": {
        "images": true,
        "groups": true
      }
    }
  }
}
```

#### Multi-account

```jsonc
{
  "connectors": {
    "wechat": {
      "accounts": {
        "main":    { "apiKey": "...", "proxyUrl": "https://proxy1.example.com" },
        "support": { "apiKey": "...", "proxyUrl": "https://proxy2.example.com" }
      }
    }
  }
}
```

## How it works

1. On agent startup the plugin reads config, spins up a local HTTP webhook
   server (default port 18790, bound to `127.0.0.1` only), and connects to the
   proxy.
2. If the WeChat session is not active, it fetches a QR-code login URL and
   prints it to the terminal. Scan it with the WeChat mobile app.
3. Once logged in, the proxy pushes inbound messages to the webhook server.
   The plugin normalises the payload and routes it through the elizaOS message
   pipeline (the agent reads and replies normally).
4. Outgoing replies are chunked at 2 000 characters and sent back via the proxy.
5. A background health check runs every 60 seconds and re-initiates login if
   the session expires.

## Security model

- The webhook receiver binds `127.0.0.1` and registers a
  `http://127.0.0.1:<port>/webhook/wechat/<accountId>` URL with the proxy, so
  the proxy must run on the same host. The static API key authenticates
  webhook POSTs but travels over plaintext HTTP — loopback binding keeps it
  off the LAN.
- The proxy operator holds the API key and vouches for sender identities:
  sender wxids in webhook payloads are trusted as delivered. Pairing your
  owner account over WeChat therefore extends full OWNER trust to the proxy
  operator — a forged POST naming the owner's wxid produces OWNER-role turns.
  Only pair owners over WeChat with a proxy you control.
