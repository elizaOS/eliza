---
title: "OpenRouter Plugin"
sidebarTitle: "OpenRouter"
description: "OpenRouter multi-provider gateway for Eliza — access 200+ models from OpenAI, Anthropic, Google, Meta, and others through a single API."
---

The OpenRouter plugin connects Eliza agents to OpenRouter's unified inference gateway, providing access to over 200 models from all major providers through a single API key and endpoint.

**Package:** `@elizaos/plugin-openrouter`

## Eliza: pinned version and upstream bundle bug

In the Eliza monorepo, **`@elizaos/plugin-openrouter` is pinned to `2.0.0-alpha.13`** (exact version in root `package.json`, reflected in `bun.lock`).

**Why pin**

- **`2.0.0-alpha.12` on npm is a bad publish:** the Node and browser ESM bundles are **truncated**. They include only rolled-up config helpers; the **main plugin object is missing**, yet the file still **exports** `openrouterPlugin` and a default alias. **Why runtime fails:** Bun (and any strict tooling) tries to load that file and errors because those bindings are **never declared** in the module.
- **Why not `^2.0.0-alpha.10`:** Semver ranges can float to **`alpha.12`**, which breaks `bun install` / lockfile refresh for everyone using OpenRouter.
- **Why we do not patch this in `patch-deps.mjs`:** Unlike a wrong export *name* in an otherwise complete file, this tarball omits the **entire implementation chunk**. A postinstall string replace cannot invent the plugin; the safe fix is **use a good version**.

**When to remove the pin**

After upstream publishes a fixed version, verify `dist/node/index.node.js` contains the full plugin (hundreds of lines, not ~80) and that `bun build …/index.node.js --target=bun` succeeds, then bump and relax the range if desired.

**Reference:** [Plugin resolution — pinned OpenRouter](/plugin-resolution-and-node-path#pinned-elizaosplugin-openrouter).

## Installation

```bash
eliza plugins install @elizaos/plugin-openrouter
```

## Auto-Enable

The plugin auto-enables when `OPENROUTER_API_KEY` is present:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key from [openrouter.ai](https://openrouter.ai) |
| `OPENROUTER_BASE_URL` | No | Custom base URL for the OpenRouter API |
| `OPENROUTER_BROWSER_BASE_URL` | No | Browser-only proxy endpoint base URL |
| `OPENROUTER_SMALL_MODEL` | No | Override the small model identifier |
| `OPENROUTER_LARGE_MODEL` | No | Override the large model identifier |
| `SMALL_MODEL` | No | Global alias to override the small model |
| `LARGE_MODEL` | No | Global alias to override the large model |
| `OPENROUTER_EMBEDDING_MODEL` | No | Override the embedding model identifier |
| `EMBEDDING_MODEL` | No | Global alias to override the embedding model |
| `OPENROUTER_EMBEDDING_DIMENSIONS` | No | Override embedding vector dimensions |
| `EMBEDDING_DIMENSIONS` | No | Global alias for embedding dimensions |
| `OPENROUTER_IMAGE_MODEL` | No | Override the image model identifier |
| `IMAGE_MODEL` | No | Global alias for the image model |
| `OPENROUTER_IMAGE_GENERATION_MODEL` | No | Override the image generation model |
| `IMAGE_GENERATION_MODEL` | No | Global alias for the image generation model |
| `OPENROUTER_AUTO_CLEANUP_IMAGES` | No | Automatically clean up generated images |
| `OPENROUTER_TOOL_EXECUTION_MAX_STEPS` | No | Maximum tool execution steps |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6"
      }
    }
  }
}
```

## Supported Models

OpenRouter provides access to models from all major providers. Use the full provider-prefixed model ID:

### OpenAI via OpenRouter

| Model ID | Description |
|---------|-------------|
| `openai/gpt-5` | GPT-5 flagship multimodal |
| `openai/gpt-5-mini` | Fast and efficient |
| `openai/gpt-4o` | GPT-4o multimodal |
| `openai/o3-mini` | Fast reasoning |

### Anthropic via OpenRouter

| Model ID | Description |
|---------|-------------|
| `anthropic/claude-opus-4.7` | Most capable Claude |
| `anthropic/claude-sonnet-4.6` | Balanced Claude |
| `anthropic/claude-haiku-4.5` | Fastest Claude |

### Meta via OpenRouter

| Model ID | Description |
|---------|-------------|
| `meta-llama/llama-3.1-405b-instruct` | Llama 3.1 405B |

### Google via OpenRouter

| Model ID | Description |
|---------|-------------|
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |

Browse all models at [openrouter.ai/models](https://openrouter.ai/models).

## Model Type Mapping

| elizaOS Model Type | Default OpenRouter Model |
|-------------------|------------------------|
| `TEXT_SMALL` | `google/gemini-2.0-flash-001` |
| `TEXT_LARGE` | `google/gemini-2.5-flash` |
| `IMAGE` | `x-ai/grok-2-vision-1212` |
| `IMAGE_GENERATION` | `google/gemini-2.5-flash-image-preview` |
| `TEXT_EMBEDDING` | `openai/text-embedding-3-small` |

## Features

- Single API key for 200+ models
- Automatic fallback to backup providers when primary is unavailable
- Cost optimization — routes to cheapest available provider
- Model comparison and A/B testing
- Usage analytics dashboard
- Streaming responses
- OpenAI-compatible API format
- Free models available (community tier)

## Provider Routing

OpenRouter supports routing preferences for cost, latency, or throughput:

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "openrouter",
        "model": "anthropic/claude-sonnet-4.6",
        "providerPreferences": {
          "order": ["Anthropic", "AWS Bedrock"],
          "allowFallbacks": true
        }
      }
    }
  }
}
```

## Free Models

OpenRouter offers free access to a selection of open-source models (rate-limited):

- `meta-llama/llama-3.2-3b-instruct:free`
- `google/gemma-2-9b-it:free`
- `mistralai/mistral-7b-instruct:free`

## Rate Limits and Pricing

Pricing is per-model and varies by provider. OpenRouter charges the same rates as the underlying provider plus a small markup on some models.

See [openrouter.ai/docs#limits](https://openrouter.ai/docs#limits) for rate limit details.

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — Direct OpenAI integration
- [Anthropic Plugin](/plugin-registry/llm/anthropic) — Direct Anthropic integration
- [Model Providers](/runtime/models) — Compare all providers
