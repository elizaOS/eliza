# elizaos-plugin-elizacloud

Rust implementation of the ElizaOS Cloud plugin for multi-model AI generation.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-elizacloud = "1.7.4"
```

## Usage

```rust
use elizaos_plugin_elizacloud::{
    ElizaCloudClient,
    ElizaCloudConfig,
    TextGenerationParams,
    TextEmbeddingParams,
    ImageGenerationParams,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Configure the client
    let config = ElizaCloudConfig::new("eliza_xxxxx")
        .with_base_url("https://www.elizacloud.ai/api/v1");

    let client = ElizaCloudClient::new(config)?;

    // Text generation
    let text = client.generate_text_large(TextGenerationParams {
        prompt: "What is the meaning of life?".to_string(),
        ..Default::default()
    }).await?;
    println!("Generated text: {}", text);

    // Embeddings
    let embeddings = client.generate_embedding(
        TextEmbeddingParams::single("Hello, world!")
    ).await?;
    println!("Embedding dimension: {}", embeddings[0].len());

    // Batch embeddings
    let batch_embeddings = client.generate_embedding(
        TextEmbeddingParams::batch(vec![
            "Hello".to_string(),
            "World".to_string(),
        ])
    ).await?;
    println!("Batch embeddings: {}", batch_embeddings.len());

    // Image generation
    let images = client.generate_image(ImageGenerationParams {
        prompt: "A beautiful sunset over the ocean".to_string(),
        count: 1,
        ..Default::default()
    }).await?;
    println!("Generated image URL: {}", images[0]);

    Ok(())
}
```

## Features

- **Text Generation**: Small (fast) and large (powerful) model support
- **Embeddings**: Single and batch text embedding with rate limit handling
- **Image Generation**: DALL-E style image generation
- **Image Description**: Vision model for describing images
- **Text-to-Speech**: Multiple voice options
- **Transcription**: Whisper-based audio transcription

### Feature Flags

- `native` (default): Enables native async runtime with tokio
- `wasm`: Enables WebAssembly support with wasm-bindgen

## Configuration

| Setting                | Description                      | Default                            |
| ---------------------- | -------------------------------- | ---------------------------------- |
| `api_key`              | ElizaOS Cloud API key (required) | -                                  |
| `base_url`             | Base URL for API requests        | `https://www.elizacloud.ai/api/v1` |
| `small_model`          | Model for quick tasks            | `gpt-5-mini`                      |
| `large_model`          | Model for complex tasks          | `gpt-5`                           |
| `embedding_model`      | Model for embeddings             | `text-embedding-3-small`           |
| `embedding_dimensions` | Embedding vector size            | `1536`                             |

## License

MIT



