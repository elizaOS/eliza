---
title: "Anthropic Plugin"
sidebarTitle: "Anthropic"
description: "Anthropic Claude model provider for Eliza — Claude Opus 4.7, Sonnet 4.6, Haiku 4.5, and adaptive thinking support."
---

The Anthropic plugin connects Eliza agents to Anthropic's Claude API and exposes the current Claude Opus 4.7, Claude Sonnet 4.6, and Claude Haiku 4.5 models.

**Package:** `@elizaos/plugin-anthropic`

## Installation

```bash
eliza plugins install @elizaos/plugin-anthropic
```

## Auto-Enable

The plugin auto-enables when `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` is present:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |
| `CLAUDE_API_KEY` | No | Alias that also triggers auto-enable (resolved to `ANTHROPIC_API_KEY` internally) |
| `ANTHROPIC_SMALL_MODEL` | No | Override the small model identifier (default: `claude-haiku-4-5-20251001-5-20251001`) |
| `ANTHROPIC_LARGE_MODEL` | No | Override the large model identifier (default: `claude-sonnet-4-6`) |
| `ANTHROPIC_EXPERIMENTAL_TELEMETRY` | No | Enable experimental telemetry features for debugging and usage analytics (default: `false`) |
| `ANTHROPIC_BROWSER_BASE_URL` | No | Browser-only proxy endpoint base URL for Anthropic requests (no secrets in the client) |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  }
}
```

## Supported Models

| Model | Context | Best For |
|-------|---------|---------|
| `claude-opus-4-7` | 200k | Most capable model for complex reasoning and long-running agents |
| `claude-sonnet-4-6` | 200k | Default large model for coding, analysis, and general use |
| `claude-haiku-4-5-20251001` | 200k | Fast, lightweight tasks |

## Model Type Mapping

| elizaOS Model Type | Anthropic Model |
|-------------------|----------------|
| `TEXT_SMALL` | `claude-haiku-4-5-20251001` |
| `TEXT_LARGE` | `claude-sonnet-4-6` |

## Features

- Streaming responses
- Tool use (function calling)
- Vision (image input on all models)
- Adaptive/extended thinking on `claude-sonnet-4-6` and `claude-opus-4-7`
- Structured JSON output via tool use
- 200k token context window on all models
- Prompt caching for cost reduction on repeated context

## Extended Thinking

Claude Sonnet 4.6 and Claude Opus 4.7 support Anthropic's adaptive/extended thinking modes for complex reasoning and multi-step planning.

```typescript
const response = await runtime.useModel("TEXT_LARGE", {
  prompt: "Design a database schema for a multi-tenant SaaS application.",
  thinking: { type: "enabled", budgetTokens: 10000 },
});
```

## Rate Limits and Pricing

Rate limits depend on your Anthropic usage tier. See [docs.anthropic.com/en/api/rate-limits](https://docs.anthropic.com/en/api/rate-limits) for current limits.

Pricing: [anthropic.com/pricing](https://www.anthropic.com/pricing)

## Related

- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o and reasoning models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Route between providers including Anthropic
- [Model Providers](/runtime/models) — Compare all providers
