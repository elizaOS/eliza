---
title: "Zai Plugin"
sidebarTitle: "Zai"
description: "Zai model provider for Eliza — access z.ai language models."
---

The Zai plugin connects Eliza agents to z.ai language models.

<Info>
This plugin is available from the upstream elizaOS registry. It is **not bundled** in `plugins.json` and must be installed explicitly.
</Info>

**Package:** `@elizaos/plugin-zai`

## Installation

```bash
eliza plugins install @elizaos/plugin-zai
```

## Auto-Enable

The plugin auto-enables when `ZAI_API_KEY` is present. Legacy `Z_AI_API_KEY` is also accepted for existing installs:

```bash
export ZAI_API_KEY=your-zai-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `ZAI_API_KEY` | Yes | z.ai API key |
| `Z_AI_API_KEY` | No | Legacy alias used only when `ZAI_API_KEY` is unset |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "zai"
      }
    }
  }
}
```

## Features

- Text generation via z.ai models
- Anthropic-compatible z.ai endpoint support

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between multiple providers
- [Model Providers](/runtime/models) — Compare all providers
