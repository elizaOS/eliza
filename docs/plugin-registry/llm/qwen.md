---
title: "Qwen Plugin"
sidebarTitle: "Qwen"
description: "Qwen model provider for Milady — access Alibaba Cloud's Qwen language models."
---

<Warning>
This plugin is not yet available in the Milady plugin registry. To use Qwen models today, configure them through the [OpenRouter plugin](/plugin-registry/llm/openrouter) using the appropriate model ID.
</Warning>

The Qwen plugin connects Milady agents to Alibaba Cloud's Qwen (Tongyi Qianwen) language models, providing access to multilingual models with strong Chinese and English capabilities.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when configured. It is not included in Milady's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-qwen`

## Installation

```bash
milady plugins install @elizaos/plugin-qwen
```

## Configuration

Qwen does not have an env-var auto-enable trigger. Enable it explicitly in your config:

### milady.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "qwen"
      }
    }
  },
  "plugins": {
    "allow": ["@elizaos/plugin-qwen"]
  }
}
```

Set your Qwen API key via the Alibaba Cloud DashScope console:

```bash
export QWEN_API_KEY=your-dashscope-api-key
```

## Supported Models

| Model | Context Window | Description |
|-------|---------------|-------------|
| `qwen-max` | 32K | Flagship model, best quality |
| `qwen-plus` | 128K | Balanced performance and cost |
| `qwen-turbo` | 128K | Fast, cost-effective |
| `qwen-long` | 10M | Ultra-long context support |
| `qwen-vl-max` | 32K | Vision-language model |
| `qwen-vl-plus` | 32K | Vision-language (balanced) |

## Features

- Multilingual support (strong Chinese and English)
- Streaming responses
- Tool use / function calling
- Vision-language capabilities (VL models)
- Ultra-long context support (qwen-long)

## Related

- [DeepSeek Plugin](/plugin-registry/llm/deepseek) — DeepSeek models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between multiple providers
- [Model Providers](/runtime/models) — Compare all providers
