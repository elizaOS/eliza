# @elizaos/plugin-zalo

Zalo Official Account Bot API integration for elizaOS agents. This plugin enables AI agents to communicate through Zalo, Vietnam's leading messaging platform.

## Features

- **Zalo Official Account API** - Full integration with Zalo's Bot API
- **Token-based Authentication** - OAuth2 with access token and refresh token support
- **Webhook/Polling Support** - Receive messages via webhooks (production) or polling (development)
- **Direct Messages** - Send and receive DMs (Zalo OA limitation - groups not supported)
- **Text & Media Messages** - Support for text and image messages
- **Proxy Support** - Configure HTTP proxy for API requests
- **Multi-language** - TypeScript, Rust, and Python implementations

## Installation

```bash
# npm
npm install @elizaos/plugin-zalo

# bun
bun add @elizaos/plugin-zalo

# pnpm
pnpm add @elizaos/plugin-zalo
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ZALO_APP_ID` | Yes | Your Zalo Official Account App ID |
| `ZALO_SECRET_KEY` | Yes | Your Zalo OA Secret Key |
| `ZALO_ACCESS_TOKEN` | Yes | OAuth access token |
| `ZALO_REFRESH_TOKEN` | No | OAuth refresh token for auto-renewal |
| `ZALO_WEBHOOK_URL` | No | HTTPS webhook URL for production |
| `ZALO_USE_POLLING` | No | Set to `true` for polling mode (dev only) |
| `ZALO_ENABLED` | No | Set to `false` to disable the plugin |
| `ZALO_PROXY_URL` | No | HTTP proxy URL for API requests |

### Example `.env`

```env
ZALO_APP_ID=your_app_id
ZALO_SECRET_KEY=your_secret_key
ZALO_ACCESS_TOKEN=your_access_token
ZALO_REFRESH_TOKEN=your_refresh_token
ZALO_WEBHOOK_URL=https://your-domain.com/zalo/webhook
ZALO_ENABLED=true
```

## Usage

### TypeScript

```typescript
import { zaloPlugin } from "@elizaos/plugin-zalo";

// Add to your agent configuration
const agent = createAgent({
  plugins: [zaloPlugin],
  // ... other config
});
```

### Python

```python
from elizaos_plugin_zalo import ZaloService, ZaloConfig

config = ZaloConfig.from_env()
service = ZaloService(config)

await service.start()
```

### Rust

```rust
use elizaos_plugin_zalo::{ZaloService, ZaloConfig};

let config = ZaloConfig::from_env()?;
let mut service = ZaloService::new(config);

service.start().await?;
```

## API Reference

### Actions

#### `SEND_ZALO_MESSAGE`

Send a message to a Zalo chat.

```typescript
{
  action: "SEND_ZALO_MESSAGE",
  chatId: "user_id",
  text: "Hello from elizaOS!"
}
```

### Providers

#### `zalo_chat_state`

Provides Zalo chat context including user ID and chat metadata.

## Webhook Setup

1. Configure your webhook URL in the Zalo OA dashboard
2. Set `ZALO_WEBHOOK_URL` to your public HTTPS endpoint
3. The plugin will automatically handle webhook verification

### Webhook Events

The plugin handles the following Zalo events:
- `message.text.received` - Text messages
- `message.image.received` - Image messages
- `message.sticker.received` - Sticker messages
- `follow` / `unfollow` - User follow/unfollow events

## Zalo OA Limitations

- **DMs Only** - Zalo OA Bot API only supports direct messages, not group chats
- **Message Length** - Maximum 2000 characters per message
- **Rate Limits** - Respect Zalo's API rate limits

## Development

### Building

```bash
# Build all implementations
bun run build

# Build TypeScript only
bun run build:ts

# Build Rust only
bun run build:rust

# Build Python only
bun run build:python
```

### Testing

```bash
# Run all tests
bun run test

# Test specific implementation
bun run test:ts
bun run test:rust
bun run test:python
```

### Linting

```bash
bun run lint
bun run lint:rust
bun run lint:python
```

## License

MIT
