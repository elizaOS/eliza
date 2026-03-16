# elizaos-plugin-rss (Rust)

Rust implementation of the RSS plugin for elizaOS.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-rss = { path = "path/to/plugin-rss/rust" }
```

## Usage

```rust
use elizaos_plugin_rss::{RssClient, RssConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create client
    let config = RssConfig::default();
    let client = RssClient::new(config)?;

    // Fetch a feed
    let feed = client.fetch_feed("https://news.ycombinator.com/rss").await?;
    println!("Feed: {}", feed.title);
    println!("Items: {}", feed.items.len());

    for item in feed.items.iter().take(5) {
        println!("  - {}", item.title);
    }

    Ok(())
}
```

## Features

- Async HTTP client using reqwest
- RSS 2.0 and Atom feed parsing with quick-xml
- Strong typing with serde
- Full feature parity with TypeScript and Python implementations

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Lint
cargo clippy --all-targets -- -D warnings

# Format
cargo fmt
```

## License

MIT



