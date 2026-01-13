# @elizaos/plugin-elizacloud

ElizaOS Cloud plugin - Multi-model AI generation with text, image, and audio support.

Available in **TypeScript**, **Python**, and **Rust** with uniform APIs.

## Installation

### TypeScript / JavaScript

```bash
npm install @elizaos/plugin-elizacloud
# or
bun add @elizaos/plugin-elizacloud
```

### Python

```bash
pip install elizaos-plugin-elizacloud
```

### Rust

```toml
[dependencies]
elizaos-plugin-elizacloud = "1.7.4"
```

## API Comparison

All three implementations provide the same model handlers with uniform naming conventions:

| Model Type             | TypeScript                 | Python                        | Rust                          |
| ---------------------- | -------------------------- | ----------------------------- | ----------------------------- |
| TEXT_SMALL             | `handleTextSmall`          | `handle_text_small`           | `handle_text_small`           |
| TEXT_LARGE             | `handleTextLarge`          | `handle_text_large`           | `handle_text_large`           |
| OBJECT_SMALL           | `handleObjectSmall`        | `handle_object_small`         | `handle_object_small`         |
| OBJECT_LARGE           | `handleObjectLarge`        | `handle_object_large`         | `handle_object_large`         |
| TEXT_EMBEDDING         | `handleTextEmbedding`      | `handle_text_embedding`       | `handle_text_embedding`       |
| TEXT_EMBEDDING (batch) | `handleBatchTextEmbedding` | `handle_batch_text_embedding` | `handle_batch_text_embedding` |
| IMAGE                  | `handleImageGeneration`    | `handle_image_generation`     | `handle_image_generation`     |
| IMAGE_DESCRIPTION      | `handleImageDescription`   | `handle_image_description`    | `handle_image_description`    |
| TEXT_TO_SPEECH         | `handleTextToSpeech`       | `handle_text_to_speech`       | `handle_text_to_speech`       |
| TRANSCRIPTION          | `handleTranscription`      | `handle_transcription`        | `handle_transcription`        |
| TEXT_TOKENIZER_ENCODE  | `handleTokenizerEncode`    | `handle_tokenizer_encode`     | `handle_tokenizer_encode`     |
| TEXT_TOKENIZER_DECODE  | `handleTokenizerDecode`    | `handle_tokenizer_decode`     | `handle_tokenizer_decode`     |

## Type Definitions

All implementations share the same type structures:

| Type                     | Description                                  |
| ------------------------ | -------------------------------------------- |
| `ElizaCloudConfig`       | Client configuration (API key, models, etc.) |
| `TextGenerationParams`   | Parameters for text generation               |
| `ObjectGenerationParams` | Parameters for structured JSON generation    |
| `TextEmbeddingParams`    | Parameters for embeddings (single or batch)  |
| `ImageGenerationParams`  | Parameters for image generation              |
| `ImageDescriptionParams` | Parameters for image description             |
| `ImageDescriptionResult` | Result from image description                |
| `TextToSpeechParams`     | Parameters for TTS                           |
| `TranscriptionParams`    | Parameters for audio transcription           |
| `TokenizeTextParams`     | Parameters for tokenization                  |
| `DetokenizeTextParams`   | Parameters for detokenization                |

## Configuration

Get your API key from [https://www.elizacloud.ai/dashboard/api-keys](https://www.elizacloud.ai/dashboard/api-keys)

| Setting                                             | Description                          | Default                            |
| --------------------------------------------------- | ------------------------------------ | ---------------------------------- |
| `api_key` / `ELIZAOS_CLOUD_API_KEY`                 | Your API key (format: `eliza_xxxxx`) | Required                           |
| `base_url` / `ELIZAOS_CLOUD_BASE_URL`               | Base URL for API requests            | `https://www.elizacloud.ai/api/v1` |
| `small_model` / `ELIZAOS_CLOUD_SMALL_MODEL`         | Small/fast model                     | `gpt-5-mini`                      |
| `large_model` / `ELIZAOS_CLOUD_LARGE_MODEL`         | Large/powerful model                 | `gpt-5`                           |
| `embedding_model` / `ELIZAOS_CLOUD_EMBEDDING_MODEL` | Embedding model                      | `text-embedding-3-small`           |
| `embedding_dimensions`                              | Embedding vector size                | `1536`                             |

## Usage Examples

### TypeScript

```typescript
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";

// Register the plugin with your agent
const agent = new Agent({
  plugins: [elizaOSCloudPlugin],
});

// Use models via runtime
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "What is the meaning of life?",
});

// Structured object generation
const obj = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: "Generate a user profile with name and age",
});

const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Hello, world!",
});

// Tokenization
const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
  prompt: "Hello tokenizer!",
  modelType: ModelType.TEXT_SMALL,
});
```

### Python

```python
import asyncio
from elizaos_plugin_elizacloud import (
    ElizaCloudClient,
    ElizaCloudConfig,
    TextGenerationParams,
    ObjectGenerationParams,
    handle_object_large,
    handle_tokenizer_encode,
    TokenizeTextParams,
)

async def main():
    config = ElizaCloudConfig(api_key="eliza_xxxxx")

    async with ElizaCloudClient(config) as client:
        # Text generation
        text = await client.generate_text(
            TextGenerationParams(prompt="Hello!"),
            model_size="large",
        )
        print(text)

    # Structured object generation
    obj = await handle_object_large(
        config,
        ObjectGenerationParams(prompt="Generate a user profile"),
    )
    print(obj)

    # Tokenization
    tokens = await handle_tokenizer_encode(
        config,
        TokenizeTextParams(prompt="Hello tokenizer!"),
    )
    print(f"Tokens: {tokens}")

asyncio.run(main())
```

### Rust

```rust
use elizaos_plugin_elizacloud::{
    ElizaCloudClient, ElizaCloudConfig, TextGenerationParams,
    ObjectGenerationParams, TokenizeTextParams,
    handle_object_large, handle_tokenizer_encode,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = ElizaCloudConfig::new("eliza_xxxxx");
    let client = ElizaCloudClient::new(config.clone())?;

    // Text generation
    let text = client.generate_text_large(TextGenerationParams {
        prompt: "What is the meaning of life?".to_string(),
        ..Default::default()
    }).await?;
    println!("{}", text);

    // Structured object generation
    let obj = handle_object_large(config.clone(), ObjectGenerationParams {
        prompt: "Generate a user profile".to_string(),
        ..Default::default()
    }).await?;
    println!("{}", obj);

    // Tokenization
    let tokens = handle_tokenizer_encode(config, TokenizeTextParams {
        prompt: "Hello tokenizer!".to_string(),
        ..Default::default()
    }).await?;
    println!("Tokens: {:?}", tokens);

    Ok(())
}
```

## Features

| Feature                 | Description                                         |
| ----------------------- | --------------------------------------------------- |
| **Text Generation**     | Small (fast) and large (powerful) model support     |
| **Object Generation**   | Structured JSON output from natural language        |
| **Text Embeddings**     | Single and batch embedding with rate limit handling |
| **Image Generation**    | DALL-E style image generation                       |
| **Image Description**   | Vision model for describing images                  |
| **Text-to-Speech**      | Multiple voice options                              |
| **Audio Transcription** | Whisper-based audio transcription                   |
| **Tokenization**        | Token counting, encoding, and decoding              |

## Development

### Building

```bash
# TypeScript
bun run build

# Python
cd python && pip install -e ".[dev]"

# Rust
cd rust && cargo build --release
```

### Testing

```bash
# TypeScript
npx vitest typescript/

# Python
cd python && pytest tests/

# Rust
cd rust && cargo test
```

### Linting

```bash
# TypeScript
bun run format

# Python
cd python && ruff check . && ruff format .

# Rust
cd rust && cargo clippy && cargo fmt
```

## Publishing

This package is published to:

- **npm**: `@elizaos/plugin-elizacloud`
- **PyPI**: `elizaos-plugin-elizacloud`
- **crates.io**: `elizaos-plugin-elizacloud`

Publishing happens automatically via GitHub Actions when the version in `package.json` changes.

### Required Secrets

Add these secrets to your GitHub repository:

- `NPM_TOKEN` - npm access token
- `PYPI_TOKEN` - PyPI API token
- `CRATES_IO_TOKEN` - crates.io API token

## License

MIT
