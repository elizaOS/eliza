# elizaOS Local AI Plugin (Rust)

Rust implementation of the Local AI plugin for elizaOS, providing local LLM inference.

## Features

- Local LLM inference using llama.cpp bindings
- Text generation with small and large models
- Embedding generation
- Optional CUDA and Metal acceleration

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-local-ai = "1.0"

# For GPU acceleration:
# elizaos-plugin-local-ai = { version = "1.0", features = ["cuda"] }
# or
# elizaos-plugin-local-ai = { version = "1.0", features = ["metal"] }
```

## Usage

```rust
use elizaos_plugin_local_ai::{LocalAIPlugin, LocalAIConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create configuration
    let config = LocalAIConfig::new("/path/to/models")
        .small_model("model.gguf")
        .gpu_layers(32);

    // Initialize plugin
    let plugin = LocalAIPlugin::new(config)?;

    // Generate text
    let params = TextGenerationParams::new("Tell me a joke")
        .max_tokens(100)
        .temperature(0.8);

    let response = plugin.generate_text_with_params(&params).await?;
    println!("{}", response);

    Ok(())
}
```

## Configuration

Environment variables:

- `MODELS_DIR`: Directory containing model files
- `CACHE_DIR`: Directory for caching
- `LOCAL_SMALL_MODEL`: Filename of small model
- `LOCAL_LARGE_MODEL`: Filename of large model
- `LOCAL_EMBEDDING_MODEL`: Filename of embedding model
- `LOCAL_EMBEDDING_DIMENSIONS`: Embedding vector dimensions (default: 384)

## License

MIT



