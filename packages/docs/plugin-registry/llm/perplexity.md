---
title: "Perplexity Plugin"
sidebarTitle: "Perplexity"
description: "Perplexity model provider for Eliza — search-augmented language models with real-time web access."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry. To use Perplexity models today, configure them through the [OpenRouter plugin](/plugin-registry/llm/openrouter) using the appropriate model ID.
</Warning>

The Perplexity plugin connects Eliza agents to Perplexity's search-augmented language models. These models combine LLM reasoning with live web search, making them ideal for agents that need up-to-date information.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-perplexity`

## Installation

```bash
eliza plugins install @elizaos/plugin-perplexity
```

## Auto-Enable

The plugin auto-enables when `PERPLEXITY_API_KEY` is present:

```bash
export PERPLEXITY_API_KEY=pplx-...
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `PERPLEXITY_API_KEY` | Yes | Perplexity API key from [perplexity.ai](https://perplexity.ai) |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "perplexity",
        "model": "sonar-pro"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Best For |
|-------|---------|---------|
| `sonar-pro` | 200k | Complex research, multi-source synthesis |
| `sonar` | 128k | General-purpose search-augmented answers |
| `sonar-reasoning-pro` | 128k | Step-by-step reasoning with citations |
| `sonar-reasoning` | 128k | Fast reasoning with web context |

## Features

- Live web search integrated into every response
- Citation-backed answers with source URLs
- Streaming responses
- Search-augmented generation (no separate RAG pipeline needed)
- Ideal for research, fact-checking, and news-aware agents

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o models (no built-in search)
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between Perplexity and other providers
- [Model Providers](/runtime/models) — Compare all providers
