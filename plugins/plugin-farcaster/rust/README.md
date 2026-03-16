# elizaOS Farcaster Plugin - Rust

A Rust implementation of the Farcaster plugin for elizaOS, providing full integration with the Farcaster decentralized social network via the Neynar API.

## Features

- **Cast Management**: Send casts, reply to casts, and manage your timeline
- **Profile Management**: Fetch and cache user profiles
- **Mentions & Notifications**: Monitor and respond to mentions
- **Timeline Provider**: Access your Farcaster feed
- **Thread Support**: Navigate and respond within cast threads
- **Async/Await**: Full async support with tokio

## Building

### Native

```bash
cargo build --release
```

### WebAssembly

```bash
wasm-pack build --target web --out-dir pkg/web
wasm-pack build --target nodejs --out-dir pkg/node
```

## Configuration

The plugin requires the following environment variables:

| Variable                   | Required | Description                                               |
| -------------------------- | -------- | --------------------------------------------------------- |
| `FARCASTER_FID`            | Yes      | Your Farcaster ID (FID)                                   |
| `FARCASTER_SIGNER_UUID`    | Yes      | Neynar signer UUID for signing casts                      |
| `FARCASTER_NEYNAR_API_KEY` | Yes      | Neynar API key for API access                             |
| `FARCASTER_DRY_RUN`        | No       | Enable dry run mode (default: false)                      |
| `FARCASTER_MODE`           | No       | Operation mode: 'polling' or 'webhook' (default: polling) |
| `MAX_CAST_LENGTH`          | No       | Maximum cast length (default: 320)                        |
| `FARCASTER_POLL_INTERVAL`  | No       | Polling interval in seconds (default: 120)                |

## Usage

```rust
use elizaos_plugin_farcaster::{FarcasterClient, FarcasterConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load configuration from environment
    let config = FarcasterConfig::from_env()?;

    // Create client
    let client = FarcasterClient::new(config)?;

    // Send a cast
    let casts = client.send_cast("Hello from elizaOS! 🤖", None).await?;
    println!("Cast sent: {}", casts[0].hash);

    // Get profile
    let profile = client.get_profile(config.fid).await?;
    println!("Username: {}", profile.username);

    Ok(())
}
```

## Testing

```bash
cargo test
```

## API Reference

### FarcasterClient

The main client for interacting with Farcaster via Neynar.

- `send_cast(text, reply_to)` - Send a new cast
- `get_cast(hash)` - Get a cast by hash
- `get_profile(fid)` - Get a user profile by FID
- `get_mentions(fid, limit)` - Get mentions for a FID
- `get_timeline(fid, limit)` - Get the user's timeline

### Types

- `Cast` - Represents a Farcaster cast
- `Profile` - Represents a Farcaster user profile
- `CastEmbed` - Represents embedded content in a cast
- `FarcasterConfig` - Configuration for the Farcaster client

## License

MIT License - see LICENSE file for details.
