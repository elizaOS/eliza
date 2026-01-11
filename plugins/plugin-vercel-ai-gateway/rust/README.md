# elizaOS Vercel AI Gateway Plugin (Rust)

Rust implementation of the Vercel AI Gateway plugin for elizaOS.

## Features

- **Text Generation**: Chat completions with GPT-5, Claude, and more
- **Streaming**: Real-time streaming text generation
- **Embeddings**: Vector embeddings generation
- **Images**: Image generation and description
- **Structured Output**: JSON object generation

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-gateway = "1.0"
```

## Quick Start

```rust
use elizaos_plugin_gateway::{GatewayConfig, GatewayPlugin, TextGenerationParams};
use futures::StreamExt;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = GatewayConfig::new("your-api-key");
    let plugin = GatewayPlugin::new(config)?;

    // Text generation
    let response = plugin.generate_text("What is quantum computing?").await?;
    println!("{}", response);

    // Streaming text generation
    let params = TextGenerationParams::new("Tell me a story about a robot");
    let mut stream = plugin.stream_text(&params).await?;

    print!("Story: ");
    while let Some(chunk) = stream.next().await {
        print!("{}", chunk?);
    }
    println!();

    // Embeddings
    let embedding = plugin.create_embedding("Hello, world!").await?;
    println!("Embedding dimensions: {}", embedding.len());

    Ok(())
}
```

## Environment Variables

```bash
# Required - one of:
export AI_GATEWAY_API_KEY="your-api-key"
export AIGATEWAY_API_KEY="your-api-key"
export VERCEL_OIDC_TOKEN="your-oidc-token"

# Optional
export AI_GATEWAY_BASE_URL="https://ai-gateway.vercel.sh/v1"
export AI_GATEWAY_SMALL_MODEL="gpt-5-mini"
export AI_GATEWAY_LARGE_MODEL="gpt-5"
export AI_GATEWAY_EMBEDDING_MODEL="text-embedding-3-small"
```

## API Reference

### GatewayPlugin

```rust
// Create from config
let plugin = GatewayPlugin::new(config)?;

// Create from environment
let plugin = get_gateway_plugin()?;

// Text generation
let response = plugin.generate_text("prompt").await?;
let response = plugin.generate_text_with_system("prompt", "system").await?;
let response = plugin.generate_text_with_params(&params).await?;

// Streaming text generation
use futures::StreamExt;
let params = TextGenerationParams::new("prompt");
let mut stream = plugin.stream_text(&params).await?;
while let Some(chunk) = stream.next().await {
    print!("{}", chunk?);
}

// Simple streaming
let mut stream = plugin.stream_text_simple("prompt").await?;

// Embeddings
let embedding = plugin.create_embedding("text").await?;

// Images
let results = plugin.generate_image(&params).await?;
let description = plugin.describe_image(&params).await?;

// Structured output
let object = plugin.generate_object("prompt").await?;
```

## Development

```bash
# Build
cargo build

# Test
cargo test

# Lint
cargo clippy
```

## License

MIT
