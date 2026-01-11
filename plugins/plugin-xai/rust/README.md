# elizaos-plugin-xai (Rust)

Rust crate for elizaOS xAI integration.

## Installation

```toml
[dependencies]
elizaos-plugin-xai = "1.0"
```

## Usage

```rust
use elizaos_plugin_xai::{GrokClient, GrokConfig, TwitterClient, TwitterConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Grok text generation
    let grok = GrokClient::new(GrokConfig::from_env()?)?;
    let result = grok.generate_text(&TextGenerationParams::new("Hello"), false).await?;
    println!("{}", result.text);

    // X (formerly Twitter) integration
    let mut x = TwitterClient::new(TwitterConfig::from_env()?)?;
    let me = x.me().await?;
    println!("@{}", me.username);

    Ok(())
}
```

## Development

```bash
# Build
cargo build

# Test
cargo test

# Lint
cargo clippy --all-targets -- -D warnings

# Format
cargo fmt
```
