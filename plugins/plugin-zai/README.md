# @elizaos/plugin-zai

First-party z.ai model provider plugin for elizaOS.

This plugin targets **z.ai's general OpenAI-compatible API** and supports:

- `TEXT_SMALL`, `TEXT_LARGE`

## Install

```bash
eliza plugins install @elizaos/plugin-zai
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ZAI_API_KEY` | Yes | – | z.ai API key |
| `Z_AI_API_KEY` | No | – | Legacy alias accepted when `ZAI_API_KEY` is unset |
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/paas/v4` | General API base URL. Coding Plan and Anthropic-compatible coding-tool endpoints are rejected here. |
| `ZAI_SMALL_MODEL` | No | `glm-4.5-air` | Small model id |
| `ZAI_LARGE_MODEL` | No | `glm-5.1` | Large model id |
| `ZAI_THINKING_TYPE` | No | – | Optional thinking mode override: `enabled` or `disabled`; unset uses z.ai's default |
| `ZAI_COT_BUDGET` | No | – | Deprecated compatibility setting. Positive values enable thinking mode; z.ai does not accept Anthropic `budget_tokens`. |
| `ZAI_COT_BUDGET_SMALL` | No | – | Deprecated compatibility setting for small-model calls |
| `ZAI_COT_BUDGET_LARGE` | No | – | Deprecated compatibility setting for large-model calls |

Prefer `ZAI_API_KEY` for new configuration. `Z_AI_API_KEY` exists only for compatibility with older z.ai wiring.

Use `zai-coding` / z.ai Coding Plan account support for subscription coding-plan workflows.
Do not point this plugin at `https://api.z.ai/api/coding/paas/v4` or
`https://api.z.ai/api/anthropic`; those are reserved for z.ai-supported coding
tools and are intentionally blocked here.

## Usage

```ts
import { AgentRuntime, ModelType } from "@elizaos/core";
import zaiPlugin from "@elizaos/plugin-zai";

const runtime = new AgentRuntime({ plugins: [zaiPlugin] });

const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a haiku about local-first AI.",
});

console.log(text);
```
