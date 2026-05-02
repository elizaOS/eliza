---
title: "Vercel AI Gateway Plugin"
sidebarTitle: "Vercel AI Gateway"
description: "Vercel AI Gateway provider for Eliza — unified multi-provider access via Vercel's AI SDK with automatic fallbacks and observability."
---

The Vercel AI Gateway plugin connects Eliza agents to Vercel's AI Gateway, providing unified access to multiple model providers through a single endpoint. This is useful for teams that want centralized API key management, provider fallbacks, and usage observability.

**Package:** `@elizaos/plugin-vercel-ai-gateway`

## Installation

```bash
eliza plugins install @elizaos/plugin-vercel-ai-gateway
```

## Auto-Enable

The plugin auto-enables when `AI_GATEWAY_API_KEY` or `AIGATEWAY_API_KEY` is present:

```bash
export AI_GATEWAY_API_KEY=your-gateway-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `AI_GATEWAY_API_KEY` | No | Vercel AI Gateway API key |
| `AIGATEWAY_API_KEY` | No | Alias that also triggers auto-enable (primary env key for auto-enable) |
| `VERCEL_OIDC_TOKEN` | No | Vercel OIDC token for authentication |
| `AI_GATEWAY_BASE_URL` | No | Custom base URL for the gateway endpoint |
| `AI_GATEWAY_SMALL_MODEL` | No | Override the small model identifier |
| `AI_GATEWAY_LARGE_MODEL` | No | Override the large model identifier |
| `AI_GATEWAY_EMBEDDING_MODEL` | No | Override the embedding model |
| `AI_GATEWAY_EMBEDDING_DIMENSIONS` | No | Override embedding vector dimensions |
| `AI_GATEWAY_IMAGE_MODEL` | No | Override the image generation model |
| `AI_GATEWAY_TIMEOUT_MS` | No | Request timeout in milliseconds |

Either `AI_GATEWAY_API_KEY`, `AIGATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` activates the plugin.

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "vercel-ai-gateway"
      }
    }
  }
}
```

## How It Works

The Vercel AI Gateway acts as a proxy between your agent and multiple LLM providers. Instead of configuring each provider separately, you configure the gateway once and route requests through it.

**Supported upstream providers include:** OpenAI, Anthropic, Google, Mistral, Cohere, and more — managed through the Vercel dashboard.

## Features

- Unified API for multiple model providers
- Automatic provider fallbacks on errors
- Centralized API key management
- Request/response logging and observability
- Rate limiting and cost controls via Vercel dashboard
- Compatible with OpenAI SDK format
- Streaming responses

## Related

- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Alternative multi-provider routing
- [OpenAI Plugin](/plugin-registry/llm/openai) — Direct OpenAI access
- [Model Providers](/runtime/models) — Compare all providers
