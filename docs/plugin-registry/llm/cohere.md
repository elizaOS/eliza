---
title: "Cohere Plugin"
sidebarTitle: "Cohere"
description: "Cohere model provider for Milady — enterprise-grade language models with RAG, embeddings, and reranking."
---

<Warning>
This plugin is not yet available in the Milady plugin registry. To use Cohere models today, configure them through the [OpenRouter plugin](/plugin-registry/llm/openrouter) using the appropriate model ID.
</Warning>

The Cohere plugin connects Milady agents to Cohere's language models, providing access to the Command family of models optimized for enterprise use cases including retrieval-augmented generation and tool use.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Milady's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-cohere`

## Installation

```bash
milady plugins install @elizaos/plugin-cohere
```

## Auto-Enable

The plugin auto-enables when `COHERE_API_KEY` is present:

```bash
export COHERE_API_KEY=your-cohere-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `COHERE_API_KEY` | Yes | Cohere API key from [cohere.com](https://cohere.com) |

### milady.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "cohere",
        "model": "command-r-plus"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Best For |
|-------|---------|---------|
| `command-r-plus` | 128k | Complex reasoning, multi-step tasks |
| `command-r` | 128k | Balanced performance and cost |
| `command-light` | 4k | Fast, lightweight tasks |
| `command` | 4k | General-purpose |

## Features

- Streaming responses
- Tool use / function calling
- Retrieval-augmented generation (RAG) with grounded answers
- Embeddings for semantic search
- Reranking for search result optimization
- Multilingual support (100+ languages)
- Structured JSON output

## Related

- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between Cohere and other providers
- [Model Providers](/runtime/models) — Compare all providers
