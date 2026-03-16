# @elizaos/plugin-groq

Groq LLM plugin for elizaOS - Fast inference with Llama, Qwen, and other models.

This plugin provides Groq API integration for elizaOS agents, enabling ultra-fast text generation, audio transcription, and text-to-speech synthesis.

## Features

- 🚀 **Fast Inference** - Leverage Groq's LPU for industry-leading inference speeds
- 📝 **Text Generation** - Generate text with Llama, Qwen, and other models
- 🎤 **Audio Transcription** - Transcribe audio with Whisper models
- 🔊 **Text-to-Speech** - Generate speech with PlayAI voices
- 🔢 **Object Generation** - Generate structured JSON objects
- 🎯 **Tokenization** - Tokenize and detokenize text

## Multi-Language Support

This plugin is available for three languages:

| Language              | Package                | Registry                                                  |
| --------------------- | ---------------------- | --------------------------------------------------------- |
| TypeScript/JavaScript | `@elizaos/plugin-groq` | [npm](https://www.npmjs.com/package/@elizaos/plugin-groq) |
| Python                | `elizaos-plugin-groq`  | [PyPI](https://pypi.org/project/elizaos-plugin-groq/)     |
| Rust                  | `elizaos-plugin-groq`  | [crates.io](https://crates.io/crates/elizaos-plugin-groq) |

## Installation

### TypeScript/JavaScript (npm)

```bash
npm install @elizaos/plugin-groq
# or
bun add @elizaos/plugin-groq
```

### Python (PyPI)

```bash
pip install elizaos-plugin-groq
```

### Rust (crates.io)

```bash
cargo add elizaos-plugin-groq
```

## Usage

### TypeScript

```typescript
import { groqPlugin } from "@elizaos/plugin-groq";

// Add to your agent's plugins
const agent = new Agent({
  plugins: [groqPlugin],
});
```

### Python

```python
from elizaos_plugin_groq import GroqClient, GenerateTextParams

async with GroqClient(api_key="your-api-key") as client:
    response = await client.generate_text_large(
        GenerateTextParams(prompt="What is the nature of reality?")
    )
    print(response)
```

### Rust

```rust
use elizaos_plugin_groq::{GroqClient, GenerateTextParams};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = GroqClient::new("your-api-key", None)?;

    let response = client.generate_text_large(GenerateTextParams {
        prompt: "What is the nature of reality?".to_string(),
        ..Default::default()
    }).await?;

    println!("{}", response);
    Ok(())
}
```

## Configuration

Set the following environment variables:

| Variable           | Required | Default                          | Description           |
| ------------------ | -------- | -------------------------------- | --------------------- |
| `GROQ_API_KEY`     | Yes      | -                                | Your Groq API key     |
| `GROQ_BASE_URL`    | No       | `https://api.groq.com/openai/v1` | Custom API base URL   |
| `GROQ_SMALL_MODEL` | No       | `llama-3.1-8b-instant`           | Model for small tasks |
| `GROQ_LARGE_MODEL` | No       | `llama-3.3-70b-versatile`        | Model for large tasks |
| `GROQ_TTS_MODEL`   | No       | `playai-tts`                     | Text-to-speech model  |
| `GROQ_TTS_VOICE`   | No       | `Chip-PlayAI`                    | TTS voice name        |

## Model Capabilities

This plugin provides handlers for the following elizaOS model types:

| Model Type              | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `TEXT_SMALL`            | Fast text generation with smaller models        |
| `TEXT_LARGE`            | High-quality text generation with larger models |
| `OBJECT_SMALL`          | JSON object generation (small)                  |
| `OBJECT_LARGE`          | JSON object generation (large)                  |
| `TRANSCRIPTION`         | Audio transcription with Whisper                |
| `TEXT_TO_SPEECH`        | Speech synthesis with PlayAI                    |
| `TEXT_TOKENIZER_ENCODE` | Tokenize text to tokens                         |
| `TEXT_TOKENIZER_DECODE` | Detokenize tokens to text                       |

## Development

### Building from Source

```bash
# TypeScript
bun install
bun run build

# Rust
cd rust && cargo build --release

# Python
cd python && pip install -e ".[dev]"
```

### Running Tests

```bash
# TypeScript
bun run test

# Rust
cd rust && cargo test

# Python
cd python && pytest
```

### Linting

```bash
# TypeScript
bun run format:check

# Rust
cd rust && cargo clippy

# Python
cd python && ruff check .
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Groq Console](https://console.groq.com)
- [Groq API Documentation](https://console.groq.com/docs)
