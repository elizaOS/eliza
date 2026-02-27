# @elizaos/plugin-avian

Avian AI model provider plugin for ElizaOS. Provides access to affordable, high-quality language models through the [Avian](https://avian.io) inference API.

## Features

- OpenAI-compatible API (chat completions, streaming, function calling)
- Text generation (TEXT_SMALL, TEXT_LARGE)
- Structured object generation (OBJECT_SMALL, OBJECT_LARGE)
- Streaming support
- Zero external dependencies beyond `@elizaos/core`

## Available Models

| Model | Context | Max Output | Input Price | Output Price |
|-------|---------|------------|-------------|--------------|
| `deepseek/deepseek-v3.2` | 164K | 65K | $0.26/M | $0.38/M |
| `moonshotai/kimi-k2.5` | 131K | 8K | $0.45/M | $2.20/M |
| `z-ai/glm-5` | 131K | 16K | $0.30/M | $2.55/M |
| `minimax/minimax-m2.5` | 1M | 1M | $0.30/M | $1.10/M |

## Installation

```bash
elizaos plugin install @elizaos/plugin-avian
```

## Configuration

Set the following environment variable or add it to your character's secrets:

```bash
AVIAN_API_KEY=your_api_key_here
```

### Optional Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `AVIAN_API_KEY` | Your Avian API key (required) | - |
| `AVIAN_BASE_URL` | Custom API base URL | `https://api.avian.io/v1` |
| `AVIAN_SMALL_MODEL` | Model for TEXT_SMALL | `deepseek/deepseek-v3.2` |
| `AVIAN_LARGE_MODEL` | Model for TEXT_LARGE | `moonshotai/kimi-k2.5` |

## Usage

Add the plugin to your character configuration:

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-avian"],
  "settings": {
    "secrets": {
      "AVIAN_API_KEY": "your_api_key_here"
    }
  }
}
```

Or import it in your project:

```typescript
import { avianPlugin } from "@elizaos/plugin-avian";

const project = {
  agents: [{
    character: myCharacter,
    plugins: [avianPlugin],
  }],
};
```

## Development

```bash
cd plugins/plugin-avian/typescript
bun install
bun run build
bun run test
```

## License

MIT
