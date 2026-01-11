# elizaOS Google GenAI Plugin (Rust)

Rust implementation of the elizaOS Google Generative AI plugin for Gemini models.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-google-genai = "1.0"
```

## Quick Start

```rust
use elizaos_plugin_google_genai::{
    GoogleGenAIClient, GoogleGenAIConfig, TextGenerationParams,
    EmbeddingParams, ObjectGenerationParams,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load config from environment
    let config = GoogleGenAIConfig::from_env()?;
    let client = GoogleGenAIClient::new(config)?;

    // Generate text
    let params = TextGenerationParams::new("What is the meaning of life?");
    let response = client.generate_text_large(params).await?;
    println!("Response: {}", response.text);

    // Generate embeddings
    let params = EmbeddingParams::new("Hello, world!");
    let embedding = client.generate_embedding(params).await?;
    println!("Embedding dimension: {}", embedding.embedding.len());

    // Generate structured JSON
    let params = ObjectGenerationParams::new("Generate a person profile with name and age")
        .with_schema(serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "number"}
            }
        }));
    let result = client.generate_object_small(params).await?;
    println!("Object: {}", result.object);

    Ok(())
}
```

## Configuration

Set the following environment variables:

| Variable                       | Required | Description                                                  |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes      | Your Google AI API key                                       |
| `GOOGLE_SMALL_MODEL`           | No       | Override small model (default: gemini-2.0-flash-001)         |
| `GOOGLE_LARGE_MODEL`           | No       | Override large model (default: gemini-2.5-pro-preview-03-25) |
| `GOOGLE_EMBEDDING_MODEL`       | No       | Override embedding model (default: text-embedding-004)       |
| `GOOGLE_IMAGE_MODEL`           | No       | Override image model                                         |
| `GOOGLE_TIMEOUT_SECONDS`       | No       | Request timeout (default: 60)                                |

## Features

- **Text Generation**: Generate text using Gemini models
- **Embeddings**: Generate text embeddings for semantic search
- **Image Analysis**: Analyze and describe images
- **JSON Object Generation**: Generate structured JSON with schema validation
- **Native & WASM**: Supports both native and WebAssembly builds
- **Type Safety**: Strong typing with no `unwrap()` in library code

## Feature Flags

- `native` (default): Full async support with tokio
- `wasm`: WebAssembly support with JavaScript interop

## Development

```bash
# Build
cargo build --release

# Run tests
cargo test

# Lint
cargo clippy --all-targets -- -D warnings

# Build for WASM
wasm-pack build --target web --out-dir pkg/web
wasm-pack build --target nodejs --out-dir pkg/node
```

## License

MIT



