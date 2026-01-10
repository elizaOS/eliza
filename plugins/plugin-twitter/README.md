# @elizaos/plugin-twitter

Multi-language Twitter/X plugin for elizaOS with full API v2 support and xAI (Grok) model integration.

## Overview

This plugin provides comprehensive Twitter/X integration for elizaOS agents across three languages:

- **TypeScript** - Full elizaOS plugin with service, actions, and providers
- **Python** - Standalone async client for Python applications
- **Rust** - High-performance async client for Rust applications

All implementations share the same API design and feature parity.

## Features

### Twitter/X API v2
- **Tweets**: Post, delete, like, retweet, quote tweet
- **Timelines**: Home timeline, user timelines, list timelines
- **Users**: Profiles, followers, following, follow/unfollow
- **Search**: Tweet search, user search
- **Polls**: Create and view polls
- **Media**: Photo and video attachments (TypeScript)

### xAI (Grok) Integration
- **Text Generation**: grok-3, grok-3-mini models
- **Embeddings**: Text embeddings for semantic search
- **Streaming**: Real-time text generation

## Installation

### TypeScript (NPM)

```bash
npm install @elizaos/plugin-twitter
# or
bun add @elizaos/plugin-twitter
```

### Python (PyPI)

```bash
pip install elizaos-plugin-twitter
```

### Rust (Cargo)

```toml
[dependencies]
elizaos-plugin-twitter = "1.3"
```

## Quick Start

### TypeScript

```typescript
import { TwitterPlugin } from "@elizaos/plugin-twitter";

// Use with elizaOS runtime
const runtime = await AgentRuntime.create({
  plugins: [TwitterPlugin],
  // ...
});

// Or use the client directly
import { Client } from "@elizaos/plugin-twitter/client";

const client = new Client();
await client.authenticate(provider);
await client.sendTweet("Hello from elizaOS!");
```

### Python

```python
import asyncio
from elizaos_plugin_twitter import TwitterClient, TwitterConfig

async def main():
    config = TwitterConfig.from_env()
    async with TwitterClient(config) as client:
        me = await client.me()
        print(f"Logged in as @{me.username}")
        
        result = await client.post_tweet("Hello from Python!")
        print(f"Posted: {result.id}")

asyncio.run(main())
```

### Rust

```rust
use elizaos_plugin_twitter::{TwitterClient, TwitterConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = TwitterConfig::from_env()?;
    let mut client = TwitterClient::new(config)?;
    
    let me = client.me().await?;
    println!("Logged in as @{}", me.username);
    
    let result = client.post_tweet("Hello from Rust!").await?;
    println!("Posted: {}", result.id);
    
    Ok(())
}
```

## Configuration

### Environment Variables

```bash
# Twitter API (Required)
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret

# Optional Twitter Config
TWITTER_BEARER_TOKEN=your_bearer_token
TWITTER_AUTH_MODE=env  # env, oauth, or broker
TWITTER_DRY_RUN=false

# Feature Flags (TypeScript plugin)
TWITTER_ENABLE_POST=false
TWITTER_ENABLE_REPLIES=true
TWITTER_ENABLE_ACTIONS=false

# xAI/Grok (Optional)
XAI_API_KEY=your_xai_api_key
XAI_MODEL=grok-3
XAI_BASE_URL=https://api.x.ai/v1
```

## Project Structure

```
plugin-twitter/
├── typescript/          # TypeScript implementation
│   ├── index.ts         # Main plugin export
│   ├── client/          # Twitter API client
│   ├── models/          # Grok model handlers
│   ├── services/        # elizaOS services
│   ├── actions/         # elizaOS actions
│   └── build.ts         # Build script
├── python/              # Python implementation
│   ├── elizaos_plugin_twitter/
│   │   ├── client.py    # Twitter API client
│   │   ├── grok.py      # Grok client
│   │   └── types.py     # Type definitions
│   └── tests/
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── client.rs    # Twitter API client
│   │   ├── grok.rs      # Grok client
│   │   └── types.rs     # Type definitions
│   └── tests/
└── package.json         # NPM package config
```

## API Parity

All three implementations provide the same core API:

| Feature | TypeScript | Python | Rust |
|---------|------------|--------|------|
| Post Tweet | ✅ | ✅ | ✅ |
| Delete Tweet | ✅ | ✅ | ✅ |
| Like/Unlike | ✅ | ✅ | ✅ |
| Retweet | ✅ | ✅ | ✅ |
| Quote Tweet | ✅ | ✅ | ✅ |
| Get Timeline | ✅ | ✅ | ✅ |
| User Profile | ✅ | ✅ | ✅ |
| Followers | ✅ | ✅ | ✅ |
| Search | ✅ | ✅ | ✅ |
| Grok Text | ✅ | ✅ | ✅ |
| Grok Streaming | ✅ | ✅ | ✅ |
| Grok Embedding | ✅ | ✅ | ✅ |

## Building

### TypeScript

```bash
cd typescript
bun run build.ts
```

### Python

```bash
cd python
pip install -e ".[dev]"
pytest
```

### Rust

```bash
cd rust
cargo build --release
cargo test
```

## Testing

```bash
# TypeScript
bun test

# Python
cd python && pytest

# Rust
cd rust && cargo test
```

## elizaOS Integration

The TypeScript implementation includes full elizaOS integration:

### Actions
- `POST_TWEET` - Post tweets with AI-generated content

### Services
- `TwitterService` - Manages Twitter client lifecycle
- Autonomous posting, interactions, and discovery

### Model Handlers
- `TEXT_SMALL` - Grok small model (grok-3-mini)
- `TEXT_LARGE` - Grok large model (grok-3)
- `TEXT_EMBEDDING` - Grok embeddings

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Twitter API v2 Docs](https://developer.twitter.com/en/docs/twitter-api)
- [xAI API Docs](https://x.ai/api)
