---
title: "Groq Plugin"
sidebarTitle: "Groq"
description: "Groq inference provider for Eliza — ultra-fast LPU-accelerated inference for Llama, Mixtral, and Gemma models."
---

The Groq plugin connects Eliza agents to Groq's inference API. Groq's Language Processing Unit (LPU) delivers significantly faster token generation speeds than GPU-based inference — making it ideal for latency-sensitive agent workflows.

**Package:** `@elizaos/plugin-groq`

## Installation

```bash
eliza plugins install @elizaos/plugin-groq
```

## Auto-Enable

The plugin auto-enables when `GROQ_API_KEY` is present:

```bash
export GROQ_API_KEY=gsk_...
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key from [console.groq.com](https://console.groq.com) |
| `GROQ_BASE_URL` | No | Custom base URL for API requests |
| `GROQ_SMALL_MODEL` | No | Override the small model identifier |
| `GROQ_LARGE_MODEL` | No | Override the large model identifier |
| `GROQ_TTS_MODEL` | No | Override the text-to-speech model |
| `GROQ_TTS_VOICE` | No | Voice profile for text-to-speech output |
| `GROQ_TTS_RESPONSE_FORMAT` | No | Output format for text-to-speech audio |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "groq",
        "model": "llama-3.3-70b-versatile"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Speed | Best For |
|-------|---------|-------|---------|
| `openai/gpt-oss-20b` | 128k | Fastest | Default small model |
| `llama-3.3-70b-versatile` | 128k | Fast | General-purpose, balanced |
| `llama-3.1-70b-versatile` | 128k | Fast | Reasoning and analysis |
| `llama-3.1-8b-instant` | 128k | Fastest | High-throughput, simple tasks |
| `llama-3.2-90b-vision-preview` | 128k | Fast | Vision tasks |
| `llama-3.2-11b-vision-preview` | 128k | Fastest | Fast vision tasks |
| `mixtral-8x7b-32768` | 32k | Fast | Code and technical tasks |
| `gemma2-9b-it` | 8k | Fastest | Efficient instruction following |
| `llama-guard-3-8b` | 8k | Fast | Content moderation |

## Model Type Mapping

| elizaOS Model Type | Groq Model |
|-------------------|-----------|
| `TEXT_SMALL` | `openai/gpt-oss-20b` |
| `TEXT_LARGE` | `llama-3.3-70b-versatile` |
| `IMAGE_DESCRIPTION` | `llama-3.2-11b-vision-preview` |

## Features

- Ultra-low latency generation (typically 250–800 tokens/second)
- Streaming responses
- Tool use / function calling (on select models)
- Vision input (Llama 3.2 vision models)
- Compatible with OpenAI SDK format
- Free tier available

## Performance Characteristics

Groq's LPU architecture excels at:

- **Time to first token**: Typically under 200ms
- **Token throughput**: 250–800+ tokens/second (model-dependent)
- **Latency consistency**: Very low jitter compared to GPU clusters

This makes Groq particularly well-suited for:
- Real-time chat agents where response latency matters
- High-frequency autonomous agent loops
- Applications requiring consistent, predictable latency

## Rate Limits

Groq enforces per-minute token limits by model. Free tier limits are lower; paid tiers scale based on usage.

See [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits) for current limits.

## Pricing

Groq offers a free tier. Paid usage is billed per million tokens.

See [groq.com/pricing](https://groq.com/pricing) for current rates.

## Related

- [Ollama Plugin](/plugin-registry/llm/ollama) — Local model inference (no API key needed)
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between Groq and other providers
- [Model Providers](/runtime/models) — Compare all providers
