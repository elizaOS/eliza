# @elizaos/plugin-wechat

WeChat connector plugin for [elizaOS](https://github.com/elizaOS/eliza) via proxy API.

## Features
- Text and image messaging
- DM and group support
- Multi-account support
- QR code login flow
- Webhook-based message delivery

## Install

```bash
npx elizaos plugins add @elizaos/plugin-wechat
```

## Configuration

| Env Var | Description |
|---------|-------------|
| `WECHAT_API_KEY` | Proxy service API key |
| `WECHAT_WEBHOOK_PORT` | Webhook listener port (default: 18790) |

## License
MIT
