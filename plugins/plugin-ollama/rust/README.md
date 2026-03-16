# elizaOS Plugin Ollama (Rust)

Ollama API client for elizaOS - Rust implementation with text and object generation.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-ollama = "1.0"
```

## Usage

```rust
use elizaos_plugin_ollama::{OllamaClient, OllamaConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = OllamaConfig::from_env()?;
    let client = OllamaClient::new(config)?;

    let params = TextGenerationParams::new("What is the meaning of life?");
    let response = client.generate_text_large(params).await?;
    println!("Response: {}", response.text);
    Ok(())
}
```

## Configuration

The client can be configured via environment variables:

| Variable                 | Description                     | Default                   |
| ------------------------ | ------------------------------- | ------------------------- |
| `OLLAMA_API_ENDPOINT`    | Base URL for the Ollama API     | `http://localhost:11434`  |
| `OLLAMA_SMALL_MODEL`     | Model for small text generation | `gemma3:latest`           |
| `OLLAMA_LARGE_MODEL`     | Model for large text generation | `gemma3:latest`           |
| `OLLAMA_EMBEDDING_MODEL` | Model for embeddings            | `nomic-embed-text:latest` |
| `OLLAMA_TIMEOUT_SECONDS` | Request timeout                 | `300`                     |

## Features

- **Text Generation**: Generate text using small or large models
- **Object Generation**: Generate structured JSON objects
- **Text Embeddings**: Generate embeddings for semantic search
- **WebAssembly Support**: Optional WASM target for browser usage

## Feature Flags

- `native` (default): Native async runtime with Tokio
- `wasm`: WebAssembly support for browser environments

## License

MIT



