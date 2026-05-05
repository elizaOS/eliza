---
title: "OpenAI Plugin"
sidebarTitle: "OpenAI"
description: "OpenAI model provider for Eliza — GPT-5, o3, o4-mini, embeddings, image generation, and speech."
---

The OpenAI plugin connects Eliza agents to OpenAI's API, providing access to GPT-5, GPT-5-mini, the o3/o4-mini reasoning model families, DALL-E image generation, and Whisper speech-to-text.

**Package:** `@elizaos/plugin-openai`

## Installation

```bash
eliza plugins install @elizaos/plugin-openai
```

Or add to `eliza.json`:

```json
{
  "plugins": {
    "allow": ["openai"]
  }
}
```

## Auto-Enable

The plugin auto-enables when `OPENAI_API_KEY` is present in the environment:

```bash
export OPENAI_API_KEY=sk-...
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OPENAI_API_KEY` | Yes | API key from [platform.openai.com](https://platform.openai.com) |
| `OPENAI_BASE_URL` | No | Custom base URL (for Azure OpenAI or compatible APIs) |
| `OPENAI_SMALL_MODEL` | No | Override the small model identifier (default: `gpt-5-mini`) |
| `OPENAI_LARGE_MODEL` | No | Override the large model identifier (default: `gpt-5`) |
| `OPENAI_EMBEDDING_MODEL` | No | Override the embedding model (default: `text-embedding-3-small`) |
| `OPENAI_EMBEDDING_URL` | No | Custom URL for the embedding endpoint |
| `OPENAI_EMBEDDING_API_KEY` | No | Separate API key for the embedding endpoint |
| `OPENAI_EMBEDDING_DIMENSIONS` | No | Override embedding vector dimensions |
| `OPENAI_IMAGE_DESCRIPTION_MODEL` | No | Model used for image description/vision tasks |
| `OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS` | No | Max tokens for image description responses |
| `OPENAI_TTS_MODEL` | No | Override the text-to-speech model |
| `OPENAI_TTS_VOICE` | No | Voice profile for text-to-speech output |
| `OPENAI_TTS_INSTRUCTIONS` | No | Instructions for text-to-speech voice style |
| `OPENAI_EXPERIMENTAL_TELEMETRY` | No | Enable experimental telemetry features |
| `OPENAI_BROWSER_BASE_URL` | No | Browser-only proxy endpoint base URL (no secrets in the client) |
| `OPENAI_BROWSER_EMBEDDING_URL` | No | Browser-only proxy URL for embedding requests |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openai",
        "model": "gpt-5"
      }
    }
  }
}
```

## Supported Models

### Text Generation

| Model | Context | Best For |
|-------|---------|---------|
| `gpt-5` | 200k | Latest flagship, default large model |
| `gpt-5-mini` | 200k | Fast, cost-efficient tasks, default small model |
| `gpt-4o` | 128k | Multimodal reasoning |
| `gpt-5-mini` | 128k | Cost-efficient alternative |

### Reasoning Models

| Model | Context | Best For |
|-------|---------|---------|
| `o1` | 200k | Deep reasoning tasks |
| `o1-mini` | 128k | Fast reasoning |
| `o3` | 200k | State-of-the-art reasoning |
| `o3-mini` | 200k | Efficient reasoning |
| `o4-mini` | 200k | Latest efficient reasoning |

### Other Capabilities

| Capability | Model |
|-----------|-------|
| Embeddings | `text-embedding-3-small`, `text-embedding-3-large` |
| Image generation | `dall-e-3`, `dall-e-2` |
| Speech-to-text | `whisper-1` |
| Text-to-speech | `tts-1`, `tts-1-hd` |
| Vision | `gpt-5` (multimodal) |

## Model Type Mapping

| elizaOS Model Type | OpenAI Model |
|-------------------|-------------|
| `TEXT_SMALL` | `gpt-5-mini` |
| `TEXT_LARGE` | `gpt-5` |
| `TEXT_EMBEDDING` | `text-embedding-3-small` |
| `IMAGE` | `dall-e-3` |
| `TRANSCRIPTION` | `whisper-1` |
| `TEXT_TO_SPEECH` | `gpt-5-mini-tts` |

## Features

- Streaming responses
- Function/tool calling
- Vision (image input with `gpt-5`)
- Structured JSON output (`response_format: { type: "json_object" }`)
- Batch API support
- Token usage tracking

## Usage Example

```typescript
// In a plugin or action handler:
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Explain quantum entanglement in simple terms.",
  maxTokens: 500,
  temperature: 0.7,
});
```

## Rate Limits and Pricing

Rate limits depend on your OpenAI usage tier. See [platform.openai.com/docs/guides/rate-limits](https://platform.openai.com/docs/guides/rate-limits) for current limits by tier.

Pricing: [openai.com/pricing](https://openai.com/pricing)

## Related

- [Anthropic Plugin](/plugin-registry/llm/anthropic) — Claude model family
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between providers
- [Model Providers](/runtime/models) — Compare all providers
