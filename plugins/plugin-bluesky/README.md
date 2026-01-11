# @elizaos/plugin-bluesky

BlueSky plugin for elizaOS - A comprehensive AT Protocol client for social interactions on BlueSky.

## Overview

This plugin provides BlueSky integration for elizaOS agents, enabling:

- **Posting**: Create, delete, like, and repost posts
- **Direct Messaging**: Send and receive direct messages
- **Notifications**: Monitor and respond to mentions, follows, likes, and reposts
- **Profile Management**: Access user profiles and timelines
- **Automated Posting**: Schedule and automate post creation

## Multi-Language Support

This plugin is implemented in three languages with feature parity:

| Language   | Directory     | Package Name              |
| ---------- | ------------- | ------------------------- |
| TypeScript | `typescript/` | `@elizaos/plugin-bluesky` |
| Python     | `python/`     | `elizaos-plugin-bluesky`  |
| Rust       | `rust/`       | `elizaos-plugin-bluesky`  |

## Installation

### TypeScript/JavaScript

```bash
npm install @elizaos/plugin-bluesky
# or
bun add @elizaos/plugin-bluesky
```

### Python

```bash
pip install elizaos-plugin-bluesky
```

### Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-bluesky = "1.0.0"
```

## Configuration

### Environment Variables

Required:

- `BLUESKY_HANDLE`: Your BlueSky handle (e.g., `user.bsky.social`)
- `BLUESKY_PASSWORD`: Your app password (generate at https://bsky.app/settings/app-passwords)

Optional:
| Variable | Description | Default |
|----------|-------------|---------|
| `BLUESKY_SERVICE` | BlueSky service URL | `https://bsky.social` |
| `BLUESKY_DRY_RUN` | Simulate operations without executing | `false` |
| `BLUESKY_POLL_INTERVAL` | Notification polling interval (seconds) | `60` |
| `BLUESKY_ENABLE_POSTING` | Enable automated posting | `true` |
| `BLUESKY_ENABLE_DMS` | Enable direct messaging | `true` |
| `BLUESKY_POST_INTERVAL_MIN` | Minimum post interval (seconds) | `1800` |
| `BLUESKY_POST_INTERVAL_MAX` | Maximum post interval (seconds) | `3600` |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | Enable action processing | `true` |
| `BLUESKY_ACTION_INTERVAL` | Action processing interval (seconds) | `120` |
| `BLUESKY_POST_IMMEDIATELY` | Post immediately on startup | `false` |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | Max actions per batch | `5` |

## Quick Start

### TypeScript

```typescript
import { blueSkyPlugin } from "@elizaos/plugin-bluesky";

// Add to your elizaOS agent
const agent = createAgent({
  plugins: [blueSkyPlugin],
});

// Or use the client directly
import { BlueSkyClient, validateBlueSkyConfig } from "@elizaos/plugin-bluesky";

const client = new BlueSkyClient({
  service: "https://bsky.social",
  handle: "your-handle.bsky.social",
  password: "your-app-password",
});

await client.authenticate();
const post = await client.sendPost({ content: { text: "Hello BlueSky!" } });
```

### Python

```python
from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

config = BlueSkyConfig.from_env()
async with BlueSkyClient(config) as client:
    await client.authenticate()

    from elizaos_plugin_bluesky import CreatePostRequest, CreatePostContent
    request = CreatePostRequest(content=CreatePostContent(text="Hello from Python!"))
    post = await client.send_post(request)
```

### Rust

```rust
use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig, CreatePostRequest};

let config = BlueSkyConfig::from_env()?;
let client = BlueSkyClient::new(config)?;

client.authenticate().await?;
let post = client.send_post(CreatePostRequest::new("Hello from Rust!")).await?;
```

## Features

### Posting

```typescript
// Create a post
const post = await client.sendPost({
  content: { text: "Hello BlueSky!" },
});

// Reply to a post
const reply = await client.sendPost({
  content: { text: "This is a reply!" },
  replyTo: { uri: post.uri, cid: post.cid },
});

// Like a post
await client.likePost(post.uri, post.cid);

// Repost
await client.repost(post.uri, post.cid);

// Delete a post
await client.deletePost(post.uri);
```

### Direct Messages

```typescript
// Get conversations
const { conversations } = await client.getConversations();

// Get messages from a conversation
const { messages } = await client.getMessages(convoId);

// Send a message
const message = await client.sendMessage({
  convoId: "conversation-id",
  message: { text: "Hello!" },
});
```

### Notifications

```typescript
// Get notifications
const { notifications } = await client.getNotifications(50);

// Mark as read
await client.updateSeenNotifications();
```

### Timeline

```typescript
// Get timeline
const timeline = await client.getTimeline({ limit: 50 });

for (const item of timeline.feed) {
  console.log(`@${item.post.author.handle}: ${item.post.record.text}`);
}
```

### Profiles

```typescript
// Get a profile
const profile = await client.getProfile("user.bsky.social");
console.log(`${profile.displayName} - ${profile.followersCount} followers`);
```

## Events

The plugin emits the following events for elizaOS integration:

| Event                      | Description                     |
| -------------------------- | ------------------------------- |
| `bluesky.mention_received` | Agent was mentioned in a post   |
| `bluesky.follow_received`  | Agent received a new follower   |
| `bluesky.like_received`    | Agent's post was liked          |
| `bluesky.repost_received`  | Agent's post was reposted       |
| `bluesky.quote_received`   | Agent's post was quoted         |
| `bluesky.should_respond`   | Trigger for response generation |
| `bluesky.create_post`      | Trigger for automated posting   |

## Development

### TypeScript

```bash
cd typescript
bun install
bun run build
npx vitest
```

### Python

```bash
cd python
pip install -e ".[dev]"
pytest
mypy elizaos_plugin_bluesky
ruff check .
```

### Rust

```bash
cd rust
cargo build
cargo test
cargo clippy
```

## Architecture

```
plugin-bluesky/
├── typescript/           # TypeScript implementation
│   ├── index.ts         # Main plugin export
│   ├── client.ts        # BlueSky API client
│   ├── types/           # Type definitions
│   ├── services/        # Service implementations
│   ├── managers/        # Agent manager
│   └── utils/           # Configuration utilities
├── python/              # Python implementation
│   ├── elizaos_plugin_bluesky/
│   │   ├── __init__.py  # Package exports
│   │   ├── client.py    # BlueSky API client
│   │   ├── config.py    # Configuration
│   │   ├── types.py     # Type definitions
│   │   └── errors.py    # Error types
│   └── tests/           # Test suite
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── lib.rs       # Library root
│   │   ├── client.rs    # BlueSky API client
│   │   ├── config.rs    # Configuration
│   │   ├── types.rs     # Type definitions
│   │   └── error.rs     # Error types
│   └── tests/           # Integration tests
└── package.json         # Root package configuration
```

## License

MIT License - see [LICENSE](./LICENSE) for details.

## Contributing

Contributions are welcome! Please ensure your changes maintain feature parity across all three language implementations.
