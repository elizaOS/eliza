# @elizaos/plugin-google-genai

Google Generative AI (Gemini) plugin for elizaOS with native support for TypeScript, Python, and Rust.

## Features

- **Text Generation**: Generate text using Gemini 2.0 Flash and 2.5 Pro models
- **Embeddings**: Generate text embeddings with text-embedding-004
- **Image Analysis**: Analyze and describe images with multimodal capabilities
- **JSON Object Generation**: Generate structured JSON with schema validation

## Available Models

| Model Type        | Default Model                | Description                        |
| ----------------- | ---------------------------- | ---------------------------------- |
| TEXT_SMALL        | gemini-2.0-flash-001         | Fast text + structured output (responseSchema, tools) |
| TEXT_LARGE        | gemini-2.5-pro-preview-03-25 | Capable text + structured output (responseSchema, tools) |
| TEXT_EMBEDDING    | text-embedding-004           | Text embeddings (768 dimensions)   |
| IMAGE_DESCRIPTION | gemini-2.5-pro-preview-03-25 | Multimodal image analysis          |

## Installation

### TypeScript/JavaScript (npm)

```bash
npm install @elizaos/plugin-google-genai
# or
bun add @elizaos/plugin-google-genai
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

// Structured output: route through TEXT_* with `responseSchema`. Google's
// SDK accepts the schema via `responseJsonSchema` + `responseMimeType` set
// internally by the handler.
const structured = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Generate a person profile with name and age.",
  responseSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
  },
});
```
## Project Structure

```
plugin-google-genai/
├── typescript/          # TypeScript implementation
│   ├── index.ts         # Main plugin entry
│   ├── models/          # Model handlers
│   ├── utils/           # Utility functions
│   └── __tests__/       # Unit and integration tests
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

## Publishing

### npm (TypeScript)

```bash
npm publish --access public
```

## License

MIT

## Contributing

See the main [elizaOS contribution guidelines](https://github.com/elizaos/eliza/blob/main/CONTRIBUTING.md).
