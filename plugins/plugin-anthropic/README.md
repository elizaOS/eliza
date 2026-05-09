# @elizaos/plugin-anthropic

Anthropic Claude API client for elizaOS, providing text generation, streaming, image description, and structured JSON object generation capabilities.

## Features

- 🚀 **Text Generation** - Generate text with Claude models (small/large), including streaming
- 🖼️ **Image Description** - Generate titles and descriptions from image URLs
- 📋 **Object Generation** - Generate structured JSON objects with validation
- 🔒 **Strong Types** - No `any` or `unknown` types, full type safety
- ⚡ **Fail Fast** - Immediate errors on invalid input, no silent failures
- 🧪 **Real Integration Tests** - Tests against live Anthropic API

## Quick Start

### TypeScript

```typescript
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { AgentRuntime, ModelType } from "@elizaos/core";

// Register the plugin
const runtime = new AgentRuntime({
  plugins: [anthropicPlugin],
});

// Generate text
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum computing in simple terms",
});

// Generate JSON object via TEXT_LARGE with a responseSchema (native tool calling)
const result = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Create a user profile with name, email, and age",
  responseSchema: { type: "object" },
});
```
## Installation

### TypeScript (npm)

```bash
npm install @elizaos/plugin-anthropic
# or
bun add @elizaos/plugin-anthropic
```
## Configuration

All implementations use the same environment variables:

| Variable                           | Required | Default                     | Description                             |
| ---------------------------------- | -------- | --------------------------- | --------------------------------------- |
| `ANTHROPIC_API_KEY`                | **Yes**  | -                           | Your Anthropic API key                  |
| `ANTHROPIC_BASE_URL`               | No       | `https://api.anthropic.com` | API base URL                            |
| `ANTHROPIC_SMALL_MODEL`            | No       | `claude-haiku-4-5-20251001` | Small model ID                          |
| `ANTHROPIC_LARGE_MODEL`            | No       | `claude-sonnet-4-6`         | Large model ID                          |
| `ANTHROPIC_TIMEOUT_SECONDS`        | No       | `60`                        | Request timeout                         |
| `ANTHROPIC_EXPERIMENTAL_TELEMETRY` | No       | `false`                     | Enable telemetry (TS only)              |
| `ANTHROPIC_COT_BUDGET`             | No       | `0`                         | Chain-of-thought token budget (TS only) |

## Available Models

| Model ID                     | Size  | Description          |
| ---------------------------- | ----- | -------------------- |
| `claude-haiku-4-5-20251001` | Small | Fastest current Claude model |
| `claude-sonnet-4-6`         | Large | Default large model          |
| `claude-opus-4-7`           | Large | Most capable current model   |

## API Reference

### Model Types

- `TEXT_SMALL` - Text generation with small model (supports tools, toolChoice, responseSchema for structured output via native tool calling)
- `TEXT_LARGE` - Text generation with large model (supports tools, toolChoice, responseSchema for structured output via native tool calling)
- `IMAGE_DESCRIPTION` - Image analysis with title and description output

### Text Generation Parameters

| Parameter       | Type      | Description                                                              |
| --------------- | --------- | ------------------------------------------------------------------------ |
| `prompt`        | string    | The prompt to generate from                                              |
| `messages`      | array?    | Multi-turn message history (supersedes prompt when both supplied)        |
| `system`        | string?   | Optional system prompt                                                   |
| `maxTokens`     | number?   | Maximum tokens to generate                                               |
| `temperature`   | number?   | Randomness (0-1, can't use with topP)                                    |
| `topP`          | number?   | Nucleus sampling (can't use with temperature)                            |
| `stopSequences` | string[]? | Stop generation at these sequences                                       |
| `stream`        | boolean?  | Return a streaming text result when `true`                               |
| `tools`         | ToolSet?  | Native Anthropic tool definitions for tool calling                       |
| `toolChoice`    | object?   | Tool selection hint (`auto`, `required`, `none`, or named tool)          |
| `responseSchema`| object?   | JSON Schema for structured output (routes through native tool calling)   |

## Project Structure

```
plugin-anthropic/
├── typescript/           # TypeScript implementation
│   ├── index.ts         # Main entry point
│   ├── models/          # Model handlers
│   ├── providers/       # Anthropic client factories
│   ├── types/           # Type definitions
│   ├── utils/           # Utilities (config, JSON parsing)
│   └── __tests__/       # Unit and integration tests
├── rust/                 # Rust implementation
│   ├── src/             # Source code
│   │   ├── lib.rs       # Library entry
│   │   ├── client.rs    # API client
│   │   ├── config.rs    # Configuration
│   │   ├── models.rs    # Model definitions
│   │   ├── types.rs     # Type definitions
│   │   └── error.rs     # Error types
│   └── tests/           # Integration tests
├── python/              # Python implementation
│   ├── elizaos_plugin_anthropic/
│   │   ├── __init__.py  # Package entry
│   │   ├── client.py    # API client
│   │   ├── config.py    # Configuration
│   │   ├── models.py    # Model definitions
│   │   ├── types.py     # Type definitions
│   │   └── errors.py    # Error types
│   └── tests/           # Integration tests
├── package.json         # npm package config
└── README.md           # This file
```

## Development

### Prerequisites

- **TypeScript**: Bun or Node.js 18+
- **Rust**: Rust 1.70+ with cargo
- **Python**: Python 3.11+

### Running Tests

```bash
cd typescript
npx vitest

# With integration tests (requires API key)
ANTHROPIC_API_KEY=your-key npx vitest
```

### Building

```bash
# TypeScript
bun run build