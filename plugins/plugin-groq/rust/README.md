# elizaos-plugin-groq

Rust implementation of the Groq LLM plugin for elizaOS.

## Features

- 🚀 **Async-first** - Built with tokio for high-performance async operations
- 🔒 **Type-safe** - Strong typing with comprehensive error handling
- 🎯 **WASM support** - Optional WebAssembly compilation target
- 📝 **Full API coverage** - Text generation, transcription, TTS, and more

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-groq = "1.0"
```

## Usage

```rust
use elizaos_plugin_groq::{GroqClient, GenerateTextParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create client with API key
    let client = GroqClient::new("your-api-key", None)?;

    // Generate text with the large model
    let response = client.generate_text_large(GenerateTextParams {
        prompt: "Explain quantum computing in simple terms.".to_string(),
        temperature: Some(0.7),
        max_tokens: Some(1024),
        ..Default::default()
    }).await?;

    println!("Response: {}", response);
    Ok(())
}
```

### Audio Transcription

```rust
use elizaos_plugin_groq::{GroqClient, TranscriptionParams};

async fn transcribe_audio(client: &GroqClient, audio_data: Vec<u8>) -> anyhow::Result<String> {
    let text = client.transcribe(TranscriptionParams {
        audio: audio_data,
        format: "mp3".to_string(),
        model: None,
    }).await?;

    Ok(text)
}
```

### Text-to-Speech

```rust
use elizaos_plugin_groq::{GroqClient, TextToSpeechParams};

async fn generate_speech(client: &GroqClient, text: &str) -> anyhow::Result<Vec<u8>> {
    let audio = client.text_to_speech(TextToSpeechParams {
        text: text.to_string(),
        model: None,
        voice: None,
    }).await?;

    Ok(audio)
}
```

### JSON Object Generation

```rust
use elizaos_plugin_groq::{GroqClient, GenerateObjectParams};

async fn generate_json(client: &GroqClient) -> anyhow::Result<serde_json::Value> {
    let object = client.generate_object(GenerateObjectParams {
        prompt: "Generate a user profile with name, age, and hobbies".to_string(),
        temperature: Some(0.7),
        model: None,
    }).await?;

    Ok(object)
}
```

## Configuration

Create a client with custom configuration:

```rust
use elizaos_plugin_groq::{GroqClient, GroqConfig};

let config = GroqConfig {
    api_key: "your-api-key".to_string(),
    base_url: "https://api.groq.com/openai/v1".to_string(),
    small_model: "llama-3.1-8b-instant".to_string(),
    large_model: "llama-3.3-70b-versatile".to_string(),
    tts_model: "playai-tts".to_string(),
    tts_voice: "Chip-PlayAI".to_string(),
    transcription_model: "distil-whisper-large-v3-en".to_string(),
};

let client = GroqClient::with_config(config)?;
```

## Error Handling

The crate provides comprehensive error types:

```rust
use elizaos_plugin_groq::{GroqError, GroqErrorCode};

match client.generate_text_large(params).await {
    Ok(text) => println!("Success: {}", text),
    Err(GroqError::RateLimit { retry_after, .. }) => {
        if let Some(delay) = retry_after {
            println!("Rate limited, retry after {} seconds", delay);
        }
    }
    Err(GroqError::Authentication { .. }) => {
        println!("Invalid API key");
    }
    Err(e) => {
        if e.is_retryable() {
            println!("Retryable error: {}", e);
        }
    }
}
```

## Features

- `native` (default) - Native async runtime with tokio
- `wasm` - WebAssembly support with wasm-bindgen

```toml
# For WASM builds
[dependencies]
elizaos-plugin-groq = { version = "1.0", default-features = false, features = ["wasm"] }
```

## License

MIT License
