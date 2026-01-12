# @elizaos/plugin-gateway

Vercel AI Gateway plugin for elizaOS. Provides access to AI models through the Vercel AI Gateway with zero markup.

## Features

- **Text Generation**: `TEXT_SMALL`, `TEXT_LARGE` chat completions
- **Embeddings**: Vector embeddings generation
- **Images**: Image generation and description
- **Structured Output**: JSON object generation
- **Streaming**: Real-time streaming support

## Multi-Language Support

This plugin is available in three languages with full feature parity:

| Language   | Directory     | Package Name              |
| ---------- | ------------- | ------------------------- |
| TypeScript | `typescript/` | `@elizaos/plugin-gateway` |
| Python     | `python/`     | `elizaos-plugin-gateway`  |
| Rust       | `rust/`       | `elizaos-plugin-gateway`  |

## Installation

### TypeScript

```bash
npm install @elizaos/plugin-gateway
# or
bun add @elizaos/plugin-gateway
```

### Python

```bash
pip install elizaos-plugin-gateway
```

### Rust

```toml
[dependencies]
elizaos-plugin-gateway = "1.0"
```

## Quick Start

### TypeScript

```typescript
import { gatewayPlugin } from "@elizaos/plugin-gateway";
import { createAgent } from "@elizaos/core";

const agent = createAgent({
  plugins: [gatewayPlugin],
});

// Use via runtime
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "What is quantum computing?",
});
```

### Python

```python
from elizaos_plugin_gateway import GatewayPlugin

async with GatewayPlugin() as plugin:
    response = await plugin.generate_text_large("What is quantum computing?")
    print(response)
```

### Rust

```rust
use elizaos_plugin_gateway::{get_gateway_plugin, TextGenerationParams};
use futures::StreamExt;

let plugin = get_gateway_plugin()?;

// Standard text generation
let response = plugin.generate_text("What is quantum computing?").await?;
println!("{}", response);

// Streaming text generation
let params = TextGenerationParams::new("Tell me a story");
let mut stream = plugin.stream_text(&params).await?;
while let Some(chunk) = stream.next().await {
    print!("{}", chunk?);
}
```

## Configuration

Set environment variables:

```bash
# Required - one of:
export AI_GATEWAY_API_KEY="your-api-key"
export AIGATEWAY_API_KEY="your-api-key"
export VERCEL_OIDC_TOKEN="your-oidc-token"

# Optional
export AI_GATEWAY_BASE_URL="https://ai-gateway.vercel.sh/v1"
export AI_GATEWAY_SMALL_MODEL="gpt-5-mini"
export AI_GATEWAY_LARGE_MODEL="gpt-5"
export AI_GATEWAY_EMBEDDING_MODEL="text-embedding-3-small"
export AI_GATEWAY_EMBEDDING_DIMENSIONS="1536"
export AI_GATEWAY_IMAGE_MODEL="dall-e-3"
```

## Supported Model Types

| Model Type          | Description                     |
| ------------------- | ------------------------------- |
| `TEXT_SMALL`        | Fast, efficient text generation |
| `TEXT_LARGE`        | High-quality text generation    |
| `TEXT_EMBEDDING`    | Vector embeddings               |
| `OBJECT_SMALL`      | JSON generation (small model)   |
| `OBJECT_LARGE`      | JSON generation (large model)   |
| `IMAGE`             | Image generation                |
| `IMAGE_DESCRIPTION` | Image analysis                  |

## Development

### Build All

```bash
# TypeScript
bun run build:ts

# Python
bun run build:python

# Rust
bun run build:rust
```

### Test All

```bash
# TypeScript
bun run test:ts

# Python
bun run test:python

# Rust
bun run test:rust
```

### Lint

```bash
bun run lint
```

## Architecture

```
plugin-vercel-ai-gateway/
├── typescript/          # TypeScript implementation
│   ├── index.ts        # Main plugin export
│   ├── types/          # Type definitions
│   ├── models/         # Model handlers
│   ├── providers/      # HTTP client
│   └── utils/          # Configuration utilities
├── python/             # Python implementation
│   ├── elizaos_plugin_gateway/
│   │   ├── __init__.py
│   │   ├── client.py   # HTTP client
│   │   ├── config.py   # Configuration
│   │   ├── plugin.py   # Plugin class
│   │   └── types.py    # Type definitions
│   └── tests/
└── rust/               # Rust implementation
    ├── src/
    │   ├── lib.rs      # Main export
    │   ├── client.rs   # HTTP client
    │   ├── config.rs   # Configuration
    │   ├── error.rs    # Error types
    │   └── types.rs    # Type definitions
    └── tests/
```

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

Please ensure all three language implementations maintain parity.
