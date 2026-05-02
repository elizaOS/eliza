---
title: "Mistral Plugin"
sidebarTitle: "Mistral"
description: "Mistral AI model provider for Eliza — open-weight and commercial models with strong multilingual and coding capabilities."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry. To use Mistral models today, configure them through the [OpenRouter plugin](/plugin-registry/llm/openrouter) using the appropriate model ID.
</Warning>

The Mistral plugin connects Eliza agents to Mistral AI models, offering both open-weight and commercial models with competitive performance, especially for European languages and code generation.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-mistral`

## Installation

```bash
eliza plugins install @elizaos/plugin-mistral
```

## Auto-Enable

The plugin auto-enables when `MISTRAL_API_KEY` is present:

```bash
export MISTRAL_API_KEY=your-mistral-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `MISTRAL_API_KEY` | Yes | Mistral AI API key from [console.mistral.ai](https://console.mistral.ai) |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "mistral",
        "model": "mistral-large-latest"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Best For |
|-------|---------|---------|
| `mistral-large-latest` | 128k | Complex reasoning, multilingual |
| `mistral-medium-latest` | 32k | Balanced performance |
| `mistral-small-latest` | 32k | Fast, cost-efficient tasks |
| `open-mistral-nemo` | 128k | Long-context, open-weight |
| `codestral-latest` | 32k | Code generation and completion |
| `mistral-embed` | 8k | Text embeddings |

## Features

- Streaming responses
- Tool use / function calling
- Strong multilingual performance (especially European languages)
- Code generation (Codestral)
- Embeddings for semantic search
- Structured JSON output
- Guardrail-friendly moderation endpoint

## Related

- [Groq Plugin](/plugin-registry/llm/groq) — Fast inference for open-weight models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between Mistral and other providers
- [Model Providers](/runtime/models) — Compare all providers
