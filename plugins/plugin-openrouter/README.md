# @elizaos/plugin-openrouter

This plugin provides integration with various models available through the OpenRouter API via the ElizaOS platform.

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-openrouter"]
```

## Configuration

The plugin requires the OpenRouter API key and can be configured via environment variables or character settings.

**Character Settings Example:**

```json
"settings": {
  "OPENROUTER_API_KEY": "your_openrouter_api_key",
  "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1", // Optional: Default is OpenRouter endpoint
  "OPENROUTER_SMALL_MODEL": "google/gemini-flash", // Optional: Overrides default small model
  "OPENROUTER_LARGE_MODEL": "google/gemini-pro", // Optional: Overrides default large model
  "OPENROUTER_IMAGE_MODEL": "x-ai/grok-2-vision-1212", // Optional: Overrides default image model
  "OPENROUTER_IMAGE_GENERATION_MODEL": "google/gemini-2.5-flash-image-preview", // Optional: Overrides default image generation model
  "OPENROUTER_EMBEDDING_MODEL": "openai/text-embedding-3-small", // Optional: Overrides default embedding model
  "OPENROUTER_EMBEDDING_DIMENSIONS": "1536", // Optional: Sets embedding vector dimensions (256, 384, 512, 768, 1024, 1536, 2048, 3072)
  "OPENROUTER_BROWSER_BASE_URL": "https://your-proxy.example.com/openrouter"
  // Fallbacks if specific OPENROUTER models are not set
  "SMALL_MODEL": "google/gemini-flash",
  "LARGE_MODEL": "google/gemini-pro",
  "IMAGE_MODEL": "x-ai/grok-2-vision-1212",
  "IMAGE_GENERATION_MODEL": "google/gemini-2.5-flash-image-preview",
  "EMBEDDING_MODEL": "openai/text-embedding-3-small",
  "EMBEDDING_DIMENSIONS": "1536"
}
```

**`.env` File Example:**

```
OPENROUTER_API_KEY=your_openrouter_api_key
# Optional overrides:
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SMALL_MODEL=google/gemini-flash
OPENROUTER_LARGE_MODEL=google/gemini-pro
OPENROUTER_IMAGE_MODEL=x-ai/grok-2-vision-1212
OPENROUTER_IMAGE_GENERATION_MODEL=google/gemini-2.5-flash-image-preview
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_EMBEDDING_DIMENSIONS=1536
# Browser proxy (frontend builds only)
OPENROUTER_BROWSER_BASE_URL=https://your-proxy.example.com/openrouter
# Fallbacks if specific OPENROUTER models are not set
SMALL_MODEL=google/gemini-flash
LARGE_MODEL=google/gemini-pro
IMAGE_MODEL=x-ai/grok-2-vision-1212
IMAGE_GENERATION_MODEL=google/gemini-2.5-flash-image-preview
EMBEDDING_MODEL=openai/text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

### Configuration Options

- `OPENROUTER_API_KEY` (required): Your OpenRouter API key.
- `OPENROUTER_BASE_URL`: Custom API endpoint (default: https://openrouter.ai/api/v1).
- `OPENROUTER_BROWSER_BASE_URL`: Browser-only base URL to a proxy endpoint that forwards requests to OpenRouter without exposing keys.
### Browser mode and proxying

When bundled for the browser, this plugin avoids sending Authorization headers. Set `OPENROUTER_BROWSER_BASE_URL` to a server-side proxy you control that injects the OpenRouter API key. This prevents exposing secrets in frontend builds.

Example minimal proxy (Express):

```ts
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

app.post('/openrouter/*', async (req, res) => {
  const url = `https://openrouter.ai/api/v1/${req.params[0]}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });
  res.status(r.status).set(Object.fromEntries(r.headers)).send(await r.text());
});

app.listen(3000);
```
- `OPENROUTER_SMALL_MODEL`: Specific model to use for `TEXT_SMALL` and `OBJECT_SMALL`. Overrides `SMALL_MODEL` if set.
- `OPENROUTER_LARGE_MODEL`: Specific model to use for `TEXT_LARGE` and `OBJECT_LARGE`. Overrides `LARGE_MODEL` if set.
- `OPENROUTER_IMAGE_MODEL`: Specific model to use for `IMAGE_DESCRIPTION`. Overrides `IMAGE_MODEL` if set.
- `OPENROUTER_IMAGE_GENERATION_MODEL`: Specific model to use for `IMAGE` generation. Overrides `IMAGE_GENERATION_MODEL` if set.
- `OPENROUTER_EMBEDDING_MODEL`: Specific model to use for `TEXT_EMBEDDING`. Overrides `EMBEDDING_MODEL` if set.
- `OPENROUTER_EMBEDDING_DIMENSIONS`: Number of dimensions for embedding vectors. Supported values: 256, 384, 512, 768, 1024, 1536, 2048, 3072. Defaults to 1536.
- `OPENROUTER_AUTO_CLEANUP_IMAGES`: Whether to automatically delete generated images after 30 seconds (default: "false"). Set to "true" to enable auto-cleanup.
- `SMALL_MODEL`: Fallback model for small tasks (default: "google/gemini-2.0-flash-001"). Used if `OPENROUTER_SMALL_MODEL` is not set.
- `LARGE_MODEL`: Fallback model for large tasks (default: "openai/gpt-4.1-nano"). Used if `OPENROUTER_LARGE_MODEL` is not set.
- `IMAGE_MODEL`: Fallback model for image analysis (default: "x-ai/grok-2-vision-1212"). Used if `OPENROUTER_IMAGE_MODEL` is not set.
- `IMAGE_GENERATION_MODEL`: Fallback model for image generation (default: "google/gemini-2.5-flash-image-preview"). Used if `OPENROUTER_IMAGE_GENERATION_MODEL` is not set.
- `EMBEDDING_MODEL`: Fallback model for text embeddings (default: "openai/text-embedding-3-small"). Used if `OPENROUTER_EMBEDDING_MODEL` is not set.
- `EMBEDDING_DIMENSIONS`: Fallback dimension setting for embeddings (default: "1536"). Used if `OPENROUTER_EMBEDDING_DIMENSIONS` is not set.

## Provided Models

The plugin currently provides these model types:

- `TEXT_SMALL`: Optimized for fast, cost-effective text generation using the configured small model.
- `TEXT_LARGE`: For more complex text generation tasks requiring larger models, using the configured large model.
- `OBJECT_SMALL`: Generates structured JSON objects based on a prompt, using the configured small model.
- `OBJECT_LARGE`: Generates structured JSON objects based on a prompt, using the configured large model.
- `IMAGE_DESCRIPTION`: Analyzes images and provides descriptive text and titles, using the configured image model.
- `IMAGE`: Generates images from text prompts using the configured image generation model (e.g., Gemini 2.5 Flash Image Preview).
- `TEXT_EMBEDDING`: Generates vector embeddings for text input, supporting configurable dimensions from 256 to 3072, using the configured embedding model.

_Note: Audio Transcription is not currently implemented in this specific OpenRouter plugin._
