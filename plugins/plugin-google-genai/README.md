# @elizaos/plugin-google-genai

Google Generative AI (Gemini) plugin for elizaOS with native support for TypeScript, Python, and Rust.

## Features

- **Text Generation**: Generate text using Gemini 2.0 Flash and 2.5 Pro models
- **Embeddings**: Generate text embeddings with text-embedding-004
- **Image Analysis**: Analyze and describe images with multimodal capabilities
- **JSON Object Generation**: Generate structured JSON with schema validation
- **Multi-Language Support**: Native implementations in TypeScript, Python, and Rust

## Available Models

| Model Type        | Default Model                | Description                        |
| ----------------- | ---------------------------- | ---------------------------------- |
| TEXT_SMALL        | gemini-2.0-flash-001         | Fast, efficient for everyday tasks |
| TEXT_LARGE        | gemini-2.5-pro-preview-03-25 | Most capable for complex tasks     |
| TEXT_EMBEDDING    | text-embedding-004           | Text embeddings (768 dimensions)   |
| IMAGE_DESCRIPTION | gemini-2.5-pro-preview-03-25 | Multimodal image analysis          |
| OBJECT_SMALL      | gemini-2.0-flash-001         | Fast JSON generation               |
| OBJECT_LARGE      | gemini-2.5-pro-preview-03-25 | Complex JSON generation            |

## Installation

### TypeScript/JavaScript (npm)

```bash
npm install @elizaos/plugin-google-genai
# or
bun add @elizaos/plugin-google-genai
```

### Python (PyPI)

```bash
pip install elizaos-plugin-google-genai
```

### Rust (crates.io)

```toml
[dependencies]
elizaos-plugin-google-genai = "1.0"
```

## Configuration

Set the following environment variables:

| Variable                       | Required | Description                                                                  |
| ------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes      | Your Google AI API key from [Google AI Studio](https://aistudio.google.com/) |
| `GOOGLE_SMALL_MODEL`           | No       | Override small model (default: gemini-2.0-flash-001)                         |
| `GOOGLE_LARGE_MODEL`           | No       | Override large model (default: gemini-2.5-pro-preview-03-25)                 |
| `GOOGLE_EMBEDDING_MODEL`       | No       | Override embedding model (default: text-embedding-004)                       |
| `GOOGLE_IMAGE_MODEL`           | No       | Override image analysis model                                                |
| `GOOGLE_TIMEOUT_SECONDS`       | No       | Request timeout (default: 60)                                                |

## Usage

### TypeScript (elizaOS Plugin)

```typescript
import { googleGenAIPlugin } from "@elizaos/plugin-google-genai";

// Register the plugin with your elizaOS agent
const agent = new Agent({
  plugins: [googleGenAIPlugin],
});

// Use via runtime
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum mechanics in simple terms.",
});

const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Hello, world!",
});

const object = await runtime.useModel(ModelType.OBJECT_SMALL, {
  prompt: "Generate a person profile with name and age.",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  },
});
```

### Python

```python
import asyncio
from elizaos_plugin_google_genai import GoogleGenAIClient, GoogleGenAIConfig

async def main():
    # Load config from environment
    config = GoogleGenAIConfig.from_env()

    async with GoogleGenAIClient(config) as client:
        # Generate text
        response = await client.generate_text_large("What is the meaning of life?")
        print(response.text)

        # Generate embeddings
        embedding = await client.generate_embedding("Hello, world!")
        print(f"Embedding dimension: {len(embedding.embedding)}")

        # Generate structured JSON
        from elizaos_plugin_google_genai import ObjectGenerationParams

        result = await client.generate_object_small(ObjectGenerationParams(
            prompt="Generate a person profile with name and age",
            json_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "number"}
                }
            }
        ))
        print(result.object)

asyncio.run(main())
```

### Rust

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

## Project Structure

```
plugin-google-genai/
├── typescript/          # TypeScript implementation
│   ├── index.ts         # Main plugin entry
│   ├── models/          # Model handlers
│   ├── utils/           # Utility functions
│   └── __tests__/       # Unit and integration tests
├── python/              # Python implementation
│   ├── elizaos_plugin_google_genai/
│   │   ├── __init__.py
│   │   ├── client.py    # API client
│   │   ├── config.py    # Configuration
│   │   ├── types.py     # Type definitions
│   │   └── errors.py    # Error types
│   ├── tests/           # Test suite
│   └── pyproject.toml   # PyPI publishing config
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── lib.rs       # Main library entry
│   │   ├── client.rs    # API client
│   │   ├── config.rs    # Configuration
│   │   ├── types.rs     # Type definitions
│   │   └── error.rs     # Error types
│   ├── tests/           # Integration tests
│   └── Cargo.toml       # crates.io publishing config
├── package.json         # npm publishing config
└── README.md            # This file
```

## Development

### TypeScript

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun run test

# Type checking
bun run typecheck
```

### Python

```bash
cd python

# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_google_genai

# Linting
ruff check . && ruff format .
```

### Rust

```bash
cd rust

# Build
cargo build --release

# Run tests
cargo test

# Lint
cargo clippy --all-targets -- -D warnings

# Build WASM
wasm-pack build --target web --out-dir pkg/web
wasm-pack build --target nodejs --out-dir pkg/node
```

## Publishing

### npm (TypeScript)

```bash
npm publish --access public
```

### PyPI (Python)

```bash
cd python
python -m build
twine upload dist/*
```

### crates.io (Rust)

```bash
cd rust
cargo publish
```

## License

MIT

## Contributing

See the main [elizaOS contribution guidelines](https://github.com/elizaos/eliza/blob/main/CONTRIBUTING.md).
