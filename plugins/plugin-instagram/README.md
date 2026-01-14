# @elizaos/plugin-instagram

Instagram integration plugin for elizaOS agents.

## Overview

This plugin provides Instagram integration for elizaOS agents, enabling:

- Direct message handling
- Post and story interactions
- Comment management
- Media upload support
- User profile interactions

## Installation

```bash
npm install @elizaos/plugin-instagram
# or
bun add @elizaos/plugin-instagram
```

## Configuration

The plugin requires the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `INSTAGRAM_USERNAME` | Yes | Your Instagram username |
| `INSTAGRAM_PASSWORD` | Yes | Your Instagram password |
| `INSTAGRAM_VERIFICATION_CODE` | No | 2FA verification code if enabled |
| `INSTAGRAM_PROXY` | No | Proxy URL for API requests |

## Usage

### TypeScript

```typescript
import instagramPlugin from "@elizaos/plugin-instagram";

// Add to your agent's plugins
const agent = new Agent({
  plugins: [instagramPlugin],
  // ... other configuration
});
```

### Python

```python
from elizaos_plugin_instagram import InstagramService, InstagramConfig

# Create configuration
config = InstagramConfig.from_env()

# Initialize service
service = InstagramService(config)

# Start the service
await service.start()
```

## Event Types

The plugin emits the following events:

- `INSTAGRAM_MESSAGE_RECEIVED` - Direct message received
- `INSTAGRAM_MESSAGE_SENT` - Direct message sent
- `INSTAGRAM_COMMENT_RECEIVED` - Comment on post received
- `INSTAGRAM_LIKE_RECEIVED` - Like on post received
- `INSTAGRAM_FOLLOW_RECEIVED` - New follower
- `INSTAGRAM_STORY_VIEWED` - Story was viewed
- `INSTAGRAM_STORY_REPLY_RECEIVED` - Reply to story received

## Development

```bash
# Install dependencies
bun install

# Build all targets
bun run build

# Run tests
bun run test

# Lint
bun run lint
```

## License

MIT
