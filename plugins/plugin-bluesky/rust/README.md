# elizaOS BlueSky Plugin (Rust)

Rust implementation of the BlueSky plugin for elizaOS using the AT Protocol.

## Features

- Full AT Protocol support
- Posting, liking, and reposting
- Direct messaging
- Notification handling
- Profile management
- Timeline access

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-bluesky = "1.0.0"
```

## Usage

```rust
use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig, CreatePostRequest};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create configuration
    let config = BlueSkyConfig::new("your-handle.bsky.social", "your-app-password")?;

    // Or load from environment
    let config = BlueSkyConfig::from_env()?;

    // Create client
    let client = BlueSkyClient::new(config)?;

    // Authenticate
    let session = client.authenticate().await?;
    println!("Logged in as: {}", session.handle);

    // Create a post
    let request = CreatePostRequest::new("Hello from Rust!");
    let post = client.send_post(request).await?;
    println!("Created post: {}", post.uri);

    // Get timeline
    use elizaos_plugin_bluesky::TimelineRequest;
    let timeline = client.get_timeline(TimelineRequest::new().with_limit(10)).await?;
    for item in timeline.feed {
        println!("@{}: {}", item.post.author.handle, item.post.record.text);
    }

    Ok(())
}
```

## Environment Variables

Required:

- `BLUESKY_HANDLE`: Your BlueSky handle
- `BLUESKY_PASSWORD`: Your app password

Optional:

- `BLUESKY_SERVICE`: BlueSky service URL (default: https://bsky.social)
- `BLUESKY_DRY_RUN`: Enable dry run mode (default: false)
- `BLUESKY_POLL_INTERVAL`: Notification polling interval in seconds (default: 60)
- `BLUESKY_ENABLE_POSTING`: Enable automated posting (default: true)
- `BLUESKY_ENABLE_DMS`: Enable direct messaging (default: true)

## Features

- `native` (default): Full async support with tokio
- `wasm`: WebAssembly support for browser environments

## Development

```bash
# Build
cargo build

# Test
cargo test

# Build for WASM
wasm-pack build --target web --out-dir pkg/web

# Lint
cargo clippy --all-targets -- -D warnings
```

## License

MIT



