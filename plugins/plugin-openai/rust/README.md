# elizaOS OpenAI Plugin (Rust)

A type-safe async Rust client for OpenAI APIs, designed for use with elizaOS.

## Features

- 🔒 **Strong typing** with serde validation
- ⚡ **Async-first** using tokio and reqwest
- 🎯 **Fail-fast** error handling - no silent failures
- 📝 **Full API coverage**:
  - Text generation (GPT-4, GPT-4o, etc.)
  - Embeddings (text-embedding-3-small, etc.)
  - Image generation (DALL-E)
  - Image description (GPT-4 Vision)
  - Audio transcription (Whisper)
  - Text-to-speech
  - Tokenization (tiktoken)

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-openai = "1.0"
```

## Quick Start

```rust
use elizaos_plugin_openai::{OpenAIClient, OpenAIConfig, TextGenerationParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create client (uses OPENAI_API_KEY env var)
    let api_key = std::env::var("OPENAI_API_KEY")?;
    let config = OpenAIConfig::new(api_key);
    let client = OpenAIClient::new(config)?;

    // Generate text
    let params = TextGenerationParams::new("Explain quantum computing in 2 sentences.");
    let response = client.generate_text(&params).await?;
    println!("{}", response);

    // Create embedding
    let params = EmbeddingParams::new("Hello, world!");
    let embedding = client.create_embedding(&params).await?;
    println!("Embedding dimensions: {}", embedding.len());

    // Describe an image
    let params = ImageDescriptionParams::new("https://example.com/image.jpg");
    let result = client.describe_image(&params).await?;
    println!("Title: {}", result.title);
    println!("Description: {}", result.description);

    Ok(())
}
```

## Configuration

```rust
use elizaos_plugin_openai::OpenAIConfig;

let config = OpenAIConfig::new("sk-...")
    .base_url("https://api.openai.com/v1")
    .small_model("gpt-5-mini")
    .large_model("gpt-5");
```

## Tokenization

```rust
use elizaos_plugin_openai::{tokenize, detokenize, count_tokens};

// Count tokens
let count = count_tokens("Hello, world!", "gpt-5")?;
println!("Token count: {}", count);

// Tokenize and detokenize
let tokens = tokenize("Hello, world!", "gpt-5")?;
let text = detokenize(&tokens, "gpt-5")?;
```

## Error Handling

All API errors are returned as `OpenAIError`:

```rust
use elizaos_plugin_openai::{OpenAIClient, OpenAIError};

match client.generate_text(&params).await {
    Ok(response) => println!("{}", response),
    Err(OpenAIError::ApiError { status, message }) => {
        eprintln!("API error ({}): {}", status, message);
    }
    Err(e) => eprintln!("Error: {}", e),
}
```

## License

MIT
