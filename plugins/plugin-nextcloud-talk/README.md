# @elizaos/plugin-nextcloud-talk

Nextcloud Talk plugin for elizaOS with TypeScript, Rust, and Python implementations.

## Features

- Webhook bot integration with Nextcloud Talk
- HMAC-SHA256 signature verification for secure communication
- Bot secret authentication
- Support for DMs and group chats
- Reactions support
- Media attachments support

## Installation

```bash
# For TypeScript/JavaScript projects
npm install @elizaos/plugin-nextcloud-talk

# For Python projects
pip install elizaos-plugin-nextcloud-talk

# For Rust projects
cargo add elizaos-plugin-nextcloud-talk
```

## Configuration

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `NEXTCLOUD_URL` | Yes | Base URL of your Nextcloud instance | - |
| `NEXTCLOUD_BOT_SECRET` | Yes | Bot secret from `occ talk:bot:install` | - |
| `NEXTCLOUD_ENABLED` | No | Enable/disable the plugin | `true` |
| `NEXTCLOUD_WEBHOOK_PORT` | No | Webhook server port | `8788` |
| `NEXTCLOUD_WEBHOOK_HOST` | No | Webhook server host | `0.0.0.0` |
| `NEXTCLOUD_WEBHOOK_PATH` | No | Webhook endpoint path | `/nextcloud-talk-webhook` |
| `NEXTCLOUD_WEBHOOK_PUBLIC_URL` | No | Public URL for webhook (if behind proxy) | - |
| `NEXTCLOUD_ALLOWED_ROOMS` | No | Allowlist of room tokens (JSON array or comma-separated) | - |

### Setting Up the Bot in Nextcloud

1. SSH into your Nextcloud server
2. Run the following command to register the bot:

```bash
sudo -u www-data php occ talk:bot:install \
    --output json \
    "My elizaOS Bot" \
    "your_secret_here" \
    "https://your-server.com/nextcloud-talk-webhook" \
    "An AI-powered assistant"
```

3. Copy the bot secret from the output
4. Set the `NEXTCLOUD_BOT_SECRET` environment variable

## Usage

### TypeScript

```typescript
import nextcloudTalkPlugin from "@elizaos/plugin-nextcloud-talk";

// Add to your elizaOS agent
const agent = {
  plugins: [nextcloudTalkPlugin],
  // ... other config
};
```

### Python

```python
from elizaos_plugin_nextcloud_talk import (
    NextcloudTalkConfig,
    NextcloudTalkService,
)

# Load config from environment
config = NextcloudTalkConfig.from_env()

# Create and start service
service = NextcloudTalkService(config)

async def handle_message(message):
    # Process incoming message
    await service.send_message_to_room(
        message.room_token,
        "Hello from elizaOS!"
    )

service.on_message(handle_message)
await service.start()
```

### Rust

```rust
use elizaos_plugin_nextcloud_talk::{
    NextcloudTalkConfig,
    NextcloudTalkService,
};

// Load config from environment
let config = NextcloudTalkConfig::from_env()?;

// Create and start service
let mut service = NextcloudTalkService::new(config);
service.start().await?;
```

## API Reference

### Actions

- `SEND_NEXTCLOUD_TALK_MESSAGE` - Send a message to a Nextcloud Talk room

### Providers

- `nextcloud_talk_chat_state` - Provides chat context including room token, sender ID, and room type

## Architecture

The plugin uses Nextcloud Talk's webhook bot API:

1. Register a bot with Nextcloud using `occ talk:bot:install`
2. Nextcloud sends messages to your webhook endpoint
3. The plugin verifies HMAC signatures for security
4. Outgoing messages are signed with the bot secret

## Security

All incoming webhook requests are verified using HMAC-SHA256:
- Signature is computed as `HMAC-SHA256(random + body, secret)`
- Random nonce is provided in the `X-Nextcloud-Talk-Random` header
- Signature is provided in the `X-Nextcloud-Talk-Signature` header

## License

MIT
