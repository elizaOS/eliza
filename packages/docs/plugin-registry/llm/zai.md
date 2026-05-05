---
title: "Zai Plugin"
sidebarTitle: "Zai"
description: "Zai model provider for Eliza — access Homunculus Labs' Zai language models."
---

The Zai plugin connects Eliza agents to Homunculus Labs' Zai language models.

<Info>
This plugin is available from the upstream elizaOS registry. It is **not bundled** in `plugins.json` and must be installed explicitly.
</Info>

> **Third-party on-demand plugin.** This is an external plugin published by Homunculus Labs (not `@elizaos`). It is resolved from the remote plugin registry and is not included in Eliza's bundled `plugins.json` index.

**Package:** `@homunculuslabs/plugin-zai`

## Installation

```bash
eliza plugins install @elizaos/plugin-zai
```

## Auto-Enable

The plugin auto-enables when `ZAI_API_KEY` is present:

```bash
export ZAI_API_KEY=your-zai-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `ZAI_API_KEY` | Yes | Zai API key from Homunculus Labs |

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

- Text generation via Homunculus Labs models
- Streaming responses
- Tool use / function calling

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between multiple providers
- [Model Providers](/runtime/models) — Compare all providers
