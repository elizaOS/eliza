# elizaOS Twitter/X Plugin (Rust)

Rust implementation of the elizaOS Twitter plugin with full Twitter API v2 support and xAI (Grok) model integration.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-twitter = "1.3"
```

## Quick Start

### Twitter Client

```rust
use elizaos_plugin_twitter::{TwitterClient, TwitterConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create config from environment variables
    let config = TwitterConfig::from_env()?;
    let mut client = TwitterClient::new(config)?;

    // Get authenticated user
    let me = client.me().await?;
    println!("Logged in as @{}", me.username);

    // Post a tweet
    let result = client.post_tweet("Hello from elizaOS! 🤖").await?;
    println!("Posted tweet: {}", result.id);

    // Get home timeline
    let timeline = client.get_home_timeline(10, None).await?;
    for tweet in timeline.tweets {
        println!("@{}: {}...", tweet.username, &tweet.text[..50.min(tweet.text.len())]);
    }

    Ok(())
}
```

### Grok AI Integration

```rust
use elizaos_plugin_twitter::{GrokClient, GrokConfig};
use elizaos_plugin_twitter::grok::{TextGenerationParams, EmbeddingParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = GrokConfig::from_env()?;
    let client = GrokClient::new(config)?;

    // Generate text
    let params = TextGenerationParams::new("Write a witty tweet about AI agents")
        .max_tokens(100);
    
    let result = client.generate_text(&params, false).await?;
    println!("Generated: {}", result.text);

    // Create embedding
    let params = EmbeddingParams::new("Hello, world!");
    let embedding = client.create_embedding(&params).await?;
    println!("Embedding dimensions: {}", embedding.len());

    Ok(())
}
```

### Using the Plugin

```rust
use elizaos_plugin_twitter::{get_twitter_plugin, get_grok_client};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Get Twitter client from environment
    let mut twitter = get_twitter_plugin()?;
    let me = twitter.me().await?;
    println!("Twitter: @{}", me.username);

    // Get Grok client (if configured)
    if let Ok(grok) = get_grok_client() {
        let models = grok.list_models().await?;
        println!("Grok models: {}", models.len());
    }

    Ok(())
}
```

## Environment Variables

### Twitter API (Required)

```bash
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret

# Optional
TWITTER_BEARER_TOKEN=your_bearer_token
TWITTER_DRY_RUN=false
```

### xAI/Grok (Optional)

```bash
XAI_API_KEY=your_xai_api_key
XAI_MODEL=grok-3
XAI_BASE_URL=https://api.x.ai/v1
```

## API Reference

### TwitterClient

| Method | Description |
|--------|-------------|
| `me()` | Get authenticated user's profile |
| `get_profile(username)` | Get a user's profile |
| `get_user_id(username)` | Get a user's ID |
| `get_tweet(tweet_id)` | Get a single tweet |
| `post_tweet(text)` | Post a new tweet |
| `post_reply(text, reply_to_id)` | Post a reply |
| `delete_tweet(tweet_id)` | Delete a tweet |
| `like_tweet(tweet_id)` | Like a tweet |
| `retweet(tweet_id)` | Retweet a tweet |
| `follow_user(user_id)` | Follow a user |
| `get_home_timeline(...)` | Get home timeline |
| `get_user_tweets(...)` | Get user's tweets |

### GrokClient

| Method | Description |
|--------|-------------|
| `generate_text(params, use_large_model)` | Generate text |
| `stream_text(params, use_large_model)` | Stream text generation |
| `create_embedding(params)` | Create text embedding |
| `list_models()` | List available models |

## Testing

```bash
# Run tests
cargo test

# Run with all features
cargo test --all-features

# Run specific test
cargo test test_twitter_get_profile

# Clippy linting
cargo clippy --all-targets -- -D warnings
```

## Features

- `native` (default): Full async runtime with Tokio
- Future: `wasm` for browser support

## License

MIT License - see [LICENSE](../LICENSE) for details.

