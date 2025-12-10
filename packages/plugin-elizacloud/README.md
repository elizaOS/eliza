# @elizaos/plugin-elizacloud

ElizaOS Cloud plugin - Complete AI, storage, and database solution. Provides multi-model inference (GPT-4, Claude, Gemini), embeddings, image generation, transcription, TTS, managed PostgreSQL database, and cloud file storage. **A single plugin that replaces all other AI and database plugins.**

This package is part of the [ElizaOS monorepo](https://github.com/elizaOS/eliza) and is automatically published with each release.

## Installation

```bash
bun add @elizaos/plugin-elizacloud
```

Or add it to your character configuration:

```json
"plugins": ["@elizaos/plugin-elizacloud"]
```

## Getting Started

### 1. Get Your API Key

Visit [https://www.elizacloud.ai/dashboard/api-keys](https://www.elizacloud.ai/dashboard/api-keys) to create your API key. Your key will be in the format: `eliza_xxxxx`

### 2. Configure Your Environment

Set your API key in `.env`:

```bash
ELIZAOS_CLOUD_API_KEY=eliza_your_key_here

# Optional: Enable managed database
ELIZAOS_CLOUD_DATABASE=true
```

### 3. That's It!

When `ELIZAOS_CLOUD_API_KEY` is set, the ElizaOS runtime automatically uses this plugin for:
- All AI model inference (text, images, audio, embeddings)
- Database storage (when `ELIZAOS_CLOUD_DATABASE=true`)
- File storage

No need to configure OpenAI, Anthropic, or other providers separately.

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "ELIZAOS_CLOUD_API_KEY": "eliza_your_api_key_here",
  "ELIZAOS_CLOUD_BASE_URL": "https://www.elizacloud.ai/api/v1",
  "ELIZAOS_CLOUD_SMALL_MODEL": "gpt-4o-mini",
  "ELIZAOS_CLOUD_LARGE_MODEL": "gpt-4o",
  "ELIZAOS_CLOUD_EMBEDDING_MODEL": "text-embedding-3-small",
  "ELIZAOS_CLOUD_EMBEDDING_API_KEY": "eliza_your_api_key_here",
  "ELIZAOS_CLOUD_EMBEDDING_URL": "https://www.elizacloud.ai/api/v1",
  "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS": "1536",
  "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL": "gpt-4o-mini",
  "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS": "8192",
  "ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY": "false",
  "ELIZAOS_CLOUD_BROWSER_BASE_URL": "https://your-proxy.example.com/api",
  "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL": "https://your-proxy.example.com/api"
}
```

Or in `.env` file:

```bash
# Required: Your ElizaOS Cloud API key (get it from https://www.elizacloud.ai/dashboard/api-keys)
ELIZAOS_CLOUD_API_KEY=eliza_your_api_key_here

# Optional overrides (defaults shown):
ELIZAOS_CLOUD_BASE_URL=https://www.elizacloud.ai/api/v1
ELIZAOS_CLOUD_SMALL_MODEL=gpt-4o-mini
ELIZAOS_CLOUD_LARGE_MODEL=gpt-4o
ELIZAOS_CLOUD_EMBEDDING_MODEL=text-embedding-3-small
ELIZAOS_CLOUD_EMBEDDING_API_KEY=eliza_your_api_key_here
ELIZAOS_CLOUD_EMBEDDING_URL=https://www.elizacloud.ai/api/v1
ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS=1536
ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL=gpt-4o-mini
ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS=8192
ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY=false

# Browser proxy (frontend builds only)
ELIZAOS_CLOUD_BROWSER_BASE_URL=https://your-proxy.example.com/api
ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL=https://your-proxy.example.com/api
```

### Configuration Options

- `ELIZAOS_CLOUD_API_KEY` (required): Your ElizaOS Cloud API key (format: `eliza_xxxxx`)
  - Get it from: [https://www.elizacloud.ai/dashboard/api-keys](https://www.elizacloud.ai/dashboard/api-keys)
- `ELIZAOS_CLOUD_BASE_URL`: ElizaOS Cloud API endpoint (default: `https://www.elizacloud.ai/api/v1`)
- `ELIZAOS_CLOUD_SMALL_MODEL`: Small/fast model for quick tasks (default: `gpt-4o-mini`)
  - Available models: `gpt-4o-mini`, `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.0-flash`
- `ELIZAOS_CLOUD_LARGE_MODEL`: Large/powerful model for complex tasks (default: `gpt-4o`)
  - Available models: `gpt-4o-mini`, `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.0-flash`
- `ELIZAOS_CLOUD_EMBEDDING_MODEL`: Model for text embeddings (default: `text-embedding-3-small`)
- `ELIZAOS_CLOUD_EMBEDDING_API_KEY`: Separate API key for embeddings (defaults to `ELIZAOS_CLOUD_API_KEY`)
- `ELIZAOS_CLOUD_EMBEDDING_URL`: Separate endpoint for embeddings (defaults to `ELIZAOS_CLOUD_BASE_URL`)
- `ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS`: Embedding vector dimensions (default: 1536)
- `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL`: Model for image description (default: `gpt-4o-mini`)
- `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS`: Max tokens for image descriptions (default: 8192)
- `ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY`: Enable telemetry for debugging and analytics (default: false)
- `ELIZAOS_CLOUD_BROWSER_BASE_URL`: Browser-only proxy endpoint (to avoid exposing keys in frontend)
- `ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL`: Browser-only embeddings proxy endpoint

### Browser mode and proxying

When bundled for the browser, this plugin avoids sending Authorization headers. Set `ELIZAOS_CLOUD_BROWSER_BASE_URL` (and optionally `ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL`) to a server-side proxy you control that injects the ElizaOS Cloud API key. This prevents exposing secrets in frontend builds.

Example minimal proxy (Express):

```ts
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

app.post('/api/*', async (req, res) => {
  const url = `https://www.elizacloud.ai/api/v1/${req.params[0]}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ELIZAOS_CLOUD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });
  res.status(r.status).set(Object.fromEntries(r.headers)).send(await r.text());
});

app.listen(3000);
```

### Experimental Telemetry

When `ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY` is set to `true`, the plugin enables advanced telemetry features that provide:

- Enhanced debugging capabilities for model performance issues
- Detailed usage analytics for optimization
- Better observability into ElizaOS Cloud API interactions
- Foundation for future monitoring and analytics features through Sentry or other frameworks

**Note**: This feature is opt-in due to privacy considerations, as telemetry data may contain information about model usage patterns. Enable only when you need enhanced debugging or analytics capabilities.

## Features

ElizaOS Cloud provides comprehensive AI capabilities through a unified API:

### Complete AI + Database + Storage

| Feature | Description |
|---------|-------------|
| **Multi-Model AI** | GPT-4o, Claude 3.5, Gemini 2.0 - all through one API |
| **Managed Database** | PostgreSQL provisioned automatically per agent |
| **Cloud Storage** | File upload/download with credit-based pricing |
| **Embeddings** | text-embedding-3-small for RAG and memory |
| **Image Generation** | DALL-E and Gemini image models |
| **Audio** | Transcription and text-to-speech |

### Supported Model Types

The plugin provides these model classes:

- `TEXT_SMALL`: Optimized for fast, cost-effective responses (default: gpt-4o-mini)
- `TEXT_LARGE`: For complex tasks requiring deeper reasoning (default: gpt-4o)
- `TEXT_EMBEDDING`: Text embedding model (text-embedding-3-small by default)
- `IMAGE`: Image generation via Google Gemini (costs 100 credits)
- `IMAGE_DESCRIPTION`: Image analysis and description (gpt-4o-mini by default)
- `TRANSCRIPTION`: Audio transcription
- `TEXT_TO_SPEECH`: Text-to-speech generation
- `TEXT_TOKENIZER_ENCODE`: Text tokenization
- `TEXT_TOKENIZER_DECODE`: Token decoding
- `OBJECT_SMALL`: Object/structured output generation (small model)
- `OBJECT_LARGE`: Object/structured output generation (large model)

### Credit System

ElizaOS Cloud uses a credit-based pricing model:
- **Text Generation**: Token-based (varies by model)
- **Image Generation**: 100 credits per image
- **Video Generation**: 500 credits per video
- Purchase credits at: [https://www.elizacloud.ai/dashboard/billing](https://www.elizacloud.ai/dashboard/billing)

## Additional Features

### Image Generation

```js
await runtime.useModel(ModelType.IMAGE, {
  prompt: "A sunset over mountains",
  n: 1, // number of images
  size: "1024x1024", // image resolution
});
```

### Audio Transcription

```js
const transcription = await runtime.useModel(
  ModelType.TRANSCRIPTION,
  audioBuffer
);
```

### Image Analysis

```js
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  "https://example.com/image.jpg"
);
```

### Text Embeddings

```js
await runtime.useModel(ModelType.TEXT_EMBEDDING, "text to embed");
```

### Tokenizer in browser

js-tiktoken is WASM and browser-safe; this plugin uses `encodingForModel` directly in both Node and browser builds.
