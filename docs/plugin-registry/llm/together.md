---
title: "Together AI Plugin"
sidebarTitle: "Together AI"
description: "Together AI model provider for Milady — access open-source models via Together's high-performance inference platform."
---

<Warning>
This plugin is not yet available in the Milady plugin registry. To use Together AI models today, configure them through the [OpenRouter plugin](/plugin-registry/llm/openrouter) using the appropriate model ID.
</Warning>

The Together AI plugin connects Milady agents to Together's inference platform, providing access to a wide catalog of open-source models with competitive pricing and fast inference.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Milady's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-together`

## Installation

```bash
milady plugins install @elizaos/plugin-together
```

## Auto-Enable

The plugin auto-enables when `TOGETHER_API_KEY` is present:

```bash
export TOGETHER_API_KEY=your-together-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `TOGETHER_API_KEY` | Yes | Together AI API key from [api.together.ai](https://api.together.ai) |

### milady.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "together",
        "model": "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo"
      }
    }
  }
}
```

## Supported Models

Together hosts 100+ open-source models. Popular choices include:

| Model | Context | Best For |
|-------|---------|---------|
| `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` | 128k | General-purpose, fast |
| `meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo` | 128k | Most capable open model |
| `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` | 128k | Lightweight, cost-efficient |
| `mistralai/Mixtral-8x22B-Instruct-v0.1` | 64k | Code and technical tasks |
| `Qwen/Qwen2.5-72B-Instruct-Turbo` | 128k | Multilingual, strong reasoning |
| `deepseek-ai/DeepSeek-R1` | 64k | Deep reasoning |

See [together.ai/models](https://www.together.ai/models) for the full model catalog.

## Features

- Streaming responses
- Tool use / function calling (on select models)
- Compatible with OpenAI SDK format
- Fast inference with Turbo variants
- Embeddings and reranking endpoints
- Image generation models available
- Pay-per-token pricing with no minimum spend

## Related

- [Groq Plugin](/plugin-registry/llm/groq) — Ultra-fast LPU inference for select models
- [Ollama Plugin](/plugin-registry/llm/ollama) — Run open-source models locally
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between Together and other providers
- [Model Providers](/runtime/models) — Compare all providers
