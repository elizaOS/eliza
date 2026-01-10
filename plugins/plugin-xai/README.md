# elizaOS xAI Plugin

Unified xAI Grok and X (Twitter) API integration for elizaOS agents.

## Features

### xAI Grok Models
- **Text Generation**: `grok-3` (large) and `grok-3-mini` (small/fast)
- **Embeddings**: `grok-embedding` for semantic text embeddings
- **Streaming**: Real-time text generation with streaming support

### X (Twitter) API v2
- **Posts**: Create, read, delete, like, repost
- **Users**: Profile lookup, follow/unfollow, followers/following lists
- **Timeline**: Home timeline, user posts
- **Search**: Recent posts search

## Installation

```bash
# TypeScript/JavaScript
bun add @elizaos/plugin-xai

# Python
pip install elizaos-plugin-xai

# Rust - add to Cargo.toml
elizaos-plugin-xai = "1.0"
```

## Configuration

### xAI (Grok) API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XAI_API_KEY` | Yes | - | xAI API key |
| `XAI_BASE_URL` | No | `https://api.x.ai/v1` | API base URL |
| `XAI_MODEL` | No | `grok-3` | Large model |
| `XAI_SMALL_MODEL` | No | `grok-3-mini` | Small model |
| `XAI_EMBEDDING_MODEL` | No | `grok-embedding` | Embedding model |

### X (Twitter) API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `X_AUTH_MODE` | No | `env` | Auth mode: `env`, `bearer`, `oauth` |
| `X_API_KEY` | For OAuth 1.0a | - | API key (consumer key) |
| `X_API_SECRET` | For OAuth 1.0a | - | API secret (consumer secret) |
| `X_ACCESS_TOKEN` | For OAuth 1.0a | - | Access token |
| `X_ACCESS_TOKEN_SECRET` | For OAuth 1.0a | - | Access token secret |
| `X_BEARER_TOKEN` | For Bearer | - | App-only bearer token |
| `X_DRY_RUN` | No | `false` | Simulate actions without posting |

Legacy `TWITTER_*` variables are supported for backward compatibility.

## API Parity

All three language implementations provide identical functionality:

### Grok Client

| Method | TypeScript | Python | Rust |
|--------|------------|--------|------|
| `generate_text` | ✓ | ✓ | ✓ |
| `stream_text` | ✓ | ✓ | ✓ |
| `create_embedding` | ✓ | ✓ | ✓ |
| `list_models` | ✓ | ✓ | ✓ |

### X Client

| Method | TypeScript | Python | Rust |
|--------|------------|--------|------|
| `me` | ✓ | ✓ | ✓ |
| `get_profile` | ✓ | ✓ | ✓ |
| `get_post` | ✓ | ✓ | ✓ |
| `create_post` | ✓ | ✓ | ✓ |
| `delete_post` | ✓ | ✓ | ✓ |
| `like_post` / `unlike_post` | ✓ | ✓ | ✓ |
| `repost` / `unrepost` | ✓ | ✓ | ✓ |
| `follow_user` / `unfollow_user` | ✓ | ✓ | ✓ |
| `get_followers` / `get_following` | ✓ | ✓ | ✓ |
| `get_home_timeline` | ✓ | ✓ | ✓ |
| `get_user_posts` | ✓ | ✓ | ✓ |
| `search_posts` | ✓ | ✓ | ✓ |

## Usage

### TypeScript

```typescript
import { XAIPlugin } from "@elizaos/plugin-xai";

// Register with elizaOS
const agent = new AgentRuntime({
  plugins: [XAIPlugin],
});

// Use Grok for text generation
const response = await agent.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a tweet about AI",
});
```

### Python

```python
from elizaos_plugin_xai import GrokClient, GrokConfig, XClient, XConfig
from elizaos_plugin_xai.grok import TextGenerationParams

# Grok
async with GrokClient(GrokConfig.from_env()) as grok:
    result = await grok.generate_text(
        TextGenerationParams(prompt="Hello, Grok!")
    )
    print(result.text)

# X (Twitter)
async with XClient(XConfig.from_env()) as x:
    me = await x.me()
    print(f"Logged in as @{me.username}")
```

### Rust

```rust
use elizaos_plugin_xai::{GrokClient, GrokConfig, XClient, XConfig, TextGenerationParams};

// Grok
let grok = GrokClient::new(GrokConfig::from_env()?)?;
let result = grok.generate_text(&TextGenerationParams::new("Hello"), false).await?;
println!("{}", result.text);

// X (Twitter)
let mut x = XClient::new(XConfig::from_env()?)?;
let me = x.me().await?;
println!("Logged in as @{}", me.username);
```

## API Reference

### Endpoints

| Service | Base URL | Version |
|---------|----------|---------|
| xAI Grok | `https://api.x.ai/v1` | v1 |
| X API | `https://api.twitter.com/2` | v2 |

### Grok Endpoints

- `POST /chat/completions` - Text generation
- `POST /embeddings` - Create embeddings
- `GET /models` - List available models

### X API Endpoints

- `GET /users/me` - Authenticated user
- `GET /users/by/username/:username` - User lookup
- `GET /tweets/:id` - Get post
- `POST /tweets` - Create post
- `DELETE /tweets/:id` - Delete post
- `POST /users/:id/likes` - Like post
- `DELETE /users/:id/likes/:tweet_id` - Unlike post
- `POST /users/:id/retweets` - Repost
- `DELETE /users/:id/retweets/:tweet_id` - Undo repost
- `POST /users/:id/following` - Follow user
- `DELETE /users/:id/following/:target_id` - Unfollow user
- `GET /users/:id/followers` - Get followers
- `GET /users/:id/following` - Get following
- `GET /users/:id/timelines/reverse_chronological` - Home timeline
- `GET /users/:id/tweets` - User posts
- `GET /tweets/search/recent` - Search posts

## License

MIT
