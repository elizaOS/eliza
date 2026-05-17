---
title: "Models API"
sidebarTitle: "Models"
description: "REST API endpoint for listing available AI models by provider."
---

The models endpoint lists available AI models from configured providers. Results are cached on disk; use `?refresh=true` to bust the cache and fetch fresh model lists from each provider's API.

## Model Categories

Models are automatically classified into categories based on their ID:

| Category | Matching keywords in model ID |
|----------|-------------------------------|
| `chat` | Default for any model not matching other categories |
| `embedding` | `embed`, `text-embedding` |
| `image` | `dall-e`, `dalle`, `imagen`, `stable-diffusion`, `midjourney`, `flux` |
| `tts` | `tts`, `text-to-speech`, `eleven_` |
| `stt` | `whisper`, `stt`, `transcrib` |
| `other` | `moderation`, `guard`, `safety` |

## Cache Behavior

Model lists are cached per-provider on disk:

| Parameter | Value |
|-----------|-------|
| Cache location | `~/.eliza/models-cache/<provider>.json` |
| Cache TTL | **24 hours** |
| Cache format | JSON with `version`, `providerId`, `fetchedAt`, `models[]` |

Each cached file stores:

```json
{
  "version": 1,
  "providerId": "openai",
  "fetchedAt": "2026-02-19T10:00:00.000Z",
  "models": [
    { "id": "gpt-4o", "name": "GPT-4o", "category": "chat" }
  ]
}
```

Cache is invalidated when the `fetchedAt` timestamp is older than 24 hours. Use `?refresh=true` to force a cache bust.

## Supported Providers

The models endpoint fetches from providers that have API keys configured:

| Provider | Env Key | API Endpoint | Auth Method |
|----------|---------|-------------|-------------|
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1/models` | `Authorization: Bearer` |
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/models?limit=100` | `x-api-key` + `anthropic-version: 2023-06-01` |
| `google-genai` | `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` | Generative Language API `/v1beta/models` | API key in query parameter |
| `groq` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1/models` | `Authorization: Bearer` |
| `xai` | `XAI_API_KEY` | `https://api.x.ai/v1/models` | `Authorization: Bearer` |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1/models` + `/embeddings/models` | `Authorization: Bearer` |
| `ollama` | `OLLAMA_BASE_URL` | `<base>/api/tags` | No auth |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` or `AIGATEWAY_API_KEY` | Gateway `/models` | No auth required |

### Provider-Specific Notes

- **Anthropic**: Uses `x-api-key` header (not `Authorization: Bearer`) and requires the `anthropic-version` header
- **Google**: Passes the API key as a query parameter (`?key=<apiKey>`), not a header
- **Ollama**: Local-only, no authentication. Reads model names from the `/api/tags` response
- **OpenRouter**: Fetches two endpoints in parallel — `/api/v1/models` for chat/image/audio models and `/api/v1/embeddings/models` for embedding models. Uses `architecture.output_modalities` for classification

## Endpoints

### GET /api/models

List available AI models. Optionally filter by a specific provider or refresh the cache.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | No | Filter to a specific provider (e.g., `openai`, `anthropic`, `ollama`). Returns all providers if omitted |
| `refresh` | string | No | Set to `"true"` to bust the cache and fetch fresh model lists from provider APIs |

**Response (all providers)**

```json
{
  "providers": {
    "openai": [
      { "id": "gpt-4o", "name": "GPT-4o", "category": "chat" },
      { "id": "gpt-5-mini", "name": "GPT-4o Mini", "category": "chat" },
      { "id": "text-embedding-3-large", "name": "text-embedding-3-large", "category": "embedding" }
    ],
    "anthropic": [
      { "id": "claude-opus-4-7", "name": "Claude Opus 4.7", "category": "chat" }
    ]
  }
}
```

**Response (single provider)**

```json
{
  "provider": "openai",
  "models": [
    { "id": "gpt-4o", "name": "GPT-4o", "category": "chat" }
  ]
}
```

### Model Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Model identifier (e.g., `gpt-4o`, `claude-opus-4-7`) |
| `name` | string | Human-readable display name |
| `category` | string | One of: `chat`, `embedding`, `image`, `tts`, `stt`, `other` |

## Related

- [Model Providers](/runtime/models) — configuring model providers
- [Environment variables](/cli/environment) — API key variables
- [`eliza models`](/cli/models) — CLI command for checking models
