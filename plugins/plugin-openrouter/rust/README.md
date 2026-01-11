# elizaOS Plugin OpenRouter (Rust)

OpenRouter API client for elizaOS - Rust implementation with text and object generation.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-openrouter = "1.0"
```

## Usage

```rust
use elizaos_plugin_openrouter::{OpenRouterClient, OpenRouterConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = OpenRouterConfig::from_env()?;
    let client = OpenRouterClient::new(config)?;

    let params = TextGenerationParams::new("What is the meaning of life?");
    let response = client.generate_text_large(params).await?;
    println!("Response: {}", response.text);
    Ok(())
}
```

## Configuration

The client can be configured via environment variables:

| Variable                     | Description                           | Default                         |
| ---------------------------- | ------------------------------------- | ------------------------------- |
| `OPENROUTER_API_KEY`         | API key for authentication (required) | -                               |
| `OPENROUTER_BASE_URL`        | Base URL for the API                  | `https://openrouter.ai/api/v1`  |
| `OPENROUTER_SMALL_MODEL`     | Model for small text generation       | `google/gemini-2.0-flash-001`   |
| `OPENROUTER_LARGE_MODEL`     | Model for large text generation       | `google/gemini-2.5-flash`       |
| `OPENROUTER_EMBEDDING_MODEL` | Model for embeddings                  | `openai/text-embedding-3-small` |
| `OPENROUTER_TIMEOUT_SECONDS` | Request timeout                       | `60`                            |

## Features

- **Text Generation**: Generate text using various models (Claude, GPT, Gemini, etc.)
- **Object Generation**: Generate structured JSON objects
- **Text Embeddings**: Generate embeddings for semantic search
- **Multi-Model Support**: Access 100+ models through a single API
- **WebAssembly Support**: Optional WASM target for browser usage

## Feature Flags

- `native` (default): Native async runtime with Tokio
- `wasm`: WebAssembly support for browser environments

## License

MIT



