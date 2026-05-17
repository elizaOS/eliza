---
title: "xAI Plugin"
sidebarTitle: "xAI (Grok)"
description: "xAI model provider for Eliza — access Grok models for real-time knowledge, reasoning, and conversational AI."
---

The xAI plugin connects Eliza agents to xAI's Grok models, providing access to models with real-time knowledge and strong reasoning capabilities.

**Package:** `@elizaos/plugin-xai`

## Installation

```bash
eliza plugins install @elizaos/plugin-xai
```

## Auto-Enable

The plugin auto-enables when any of the following env vars are present: `X_API_KEY`, `XAI_API_KEY`, or `GROK_API_KEY`.

```bash
export XAI_API_KEY=xai-...
```

## Configuration

### xAI / Grok Model Settings

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `X_API_KEY` | Yes* | Primary key in the plugin registry |
| `XAI_API_KEY` | Yes* | Alias — also triggers auto-enable |
| `GROK_API_KEY` | Yes* | Alias — also triggers auto-enable |
| `XAI_BASE_URL` | No | Custom base URL for the xAI API |
| `XAI_MODEL` | No | Override the default model identifier |
| `XAI_SMALL_MODEL` | No | Override the small model identifier |
| `XAI_EMBEDDING_MODEL` | No | Override the embedding model identifier |
| `X_DRY_RUN` | No | When true, all X actions are simulated |
| `X_AUTH_MODE` | No | X auth mode: `env` (API keys), `oauth` (OAuth2 PKCE), or `bearer` |
| `X_ENABLE_POST` | No | Enable autonomous posting on X |
| `X_ENABLE_REPLIES` | No | Enable reply handling on X |
| `X_ENABLE_ACTIONS` | No | Enable timeline actions (like, repost) on X |
| `X_MAX_POST_LENGTH` | No | Maximum post length (up to 4000 for premium) |

\* Any one of `X_API_KEY`, `XAI_API_KEY`, or `GROK_API_KEY` activates the plugin.

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "xai",
        "model": "grok-3"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Best For |
|-------|---------|---------|
| `grok-3` | 131k | Most capable, complex reasoning |
| `grok-3-mini` | 131k | Fast reasoning with thinking mode |
| `grok-2` | 131k | General-purpose |
| `grok-2-vision` | 32k | Image understanding |

## Features

- Streaming responses
- Tool use / function calling
- Vision input (Grok 2 Vision)
- Real-time knowledge from X/Twitter
- Compatible with OpenAI SDK format
- Structured JSON output

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between xAI and other providers
- [Model Providers](/runtime/models) — Compare all providers
