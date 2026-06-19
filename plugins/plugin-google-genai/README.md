# @elizaos/plugin-google-genai

Google Generative AI (Gemini) model provider for [elizaOS](https://github.com/elizaos/eliza) agents. Registers handlers for text generation, embeddings, and image description across all elizaOS model tiers, backed by the Google Generative AI API.

## Capabilities

- **Text generation** across all model tiers: nano, small, medium, large, mega, response handler, action planner.
- **Text embeddings** with `text-embedding-004` (768 dimensions).
- **Image description** — fetch an image by URL, encode it inline, and return a `{ title, description }` object.
- **Structured output** — pass a JSON Schema as `responseSchema` to any text handler to get `application/json` back from the model.
- **Tool use** — pass function declarations via `tools` / `toolChoice` to enable function-calling on supported models.

## Auto-enable

The plugin is automatically enabled by elizaOS when any of the following environment variables is set and non-empty:

- `GOOGLE_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `GEMINI_API_KEY`

## Installation

```bash
bun add @elizaos/plugin-google-genai
```

Or register it explicitly in your agent character file:

```json
{
  "plugins": ["@elizaos/plugin-google-genai"]
}
```

## Configuration

| Environment variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | — | API key from [Google AI Studio](https://aistudio.google.com/) |
| `GOOGLE_SMALL_MODEL` | No | `gemini-2.0-flash-001` | Small/fast text model |
| `GOOGLE_LARGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | Large/capable text model |
| `GOOGLE_NANO_MODEL` | No | falls back to small | Nano text model |
| `GOOGLE_MEDIUM_MODEL` | No | falls back to small | Medium text model |
| `GOOGLE_MEGA_MODEL` | No | falls back to large | Mega text model |
| `GOOGLE_RESPONSE_HANDLER_MODEL` | No | falls back to nano | Response handler model |
| `GOOGLE_ACTION_PLANNER_MODEL` | No | falls back to medium | Action planner model |
| `GOOGLE_EMBEDDING_MODEL` | No | `text-embedding-004` | Embedding model |
| `GOOGLE_IMAGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | Image description model |

Generic fallbacks (`SMALL_MODEL`, `LARGE_MODEL`, `IMAGE_MODEL`, etc.) are also respected when the `GOOGLE_*` prefix variants are not set.

## Usage

Once the plugin is loaded, use any Gemini model through the standard elizaOS runtime interface:

```typescript
import { ModelType } from "@elizaos/core";

// Text generation
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum entanglement in plain language.",
});

// Embeddings
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Hello, world!",
});
// embedding is number[] with 768 dimensions

// Image description
const result = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  "https://example.com/image.jpg",
);
// result: { title: string; description: string }

// Structured output
const person = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Generate a sample person profile.",
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

## Available model tiers

| ModelType | Default model | Notes |
|---|---|---|
| `TEXT_NANO` | falls back to small | Fastest; shares small model by default |
| `TEXT_SMALL` | `gemini-2.0-flash-001` | Fast + structured output |
| `TEXT_MEDIUM` | falls back to small | |
| `TEXT_LARGE` | `gemini-2.5-pro-preview-03-25` | High-quality + structured output |
| `TEXT_MEGA` | falls back to large | |
| `RESPONSE_HANDLER` | falls back to nano | |
| `ACTION_PLANNER` | falls back to medium | |
| `TEXT_EMBEDDING` | `text-embedding-004` | 768-dim vectors |
| `IMAGE_DESCRIPTION` | `gemini-2.5-pro-preview-03-25` | Multimodal; fetches image by URL |

## Development

```bash
bun install
bun run --cwd plugins/plugin-google-genai build
bun run --cwd plugins/plugin-google-genai test
bun run --cwd plugins/plugin-google-genai typecheck
```

See [AGENTS.md](AGENTS.md) for the agent-facing layout reference and extension guide.
