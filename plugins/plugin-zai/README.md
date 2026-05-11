# @elizaos/plugin-zai

First-party z.ai model provider plugin for elizaOS.

This plugin targets **z.ai's Anthropic-compatible API** and supports:

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
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/anthropic/v1` | Anthropic-compatible base URL; normalized to end in `/v1` |
| `ZAI_SMALL_MODEL` | No | `claude-sonnet-4-20250514` | Small model id |
| `ZAI_LARGE_MODEL` | No | `claude-sonnet-4-20250514` | Large model id |
| `ZAI_COT_BUDGET` | No | – | Shared chain-of-thought budget in tokens |
| `ZAI_COT_BUDGET_SMALL` | No | – | Small-model chain-of-thought budget in tokens |
| `ZAI_COT_BUDGET_LARGE` | No | – | Large-model chain-of-thought budget in tokens |

Prefer `ZAI_API_KEY` for new configuration. `Z_AI_API_KEY` exists only for compatibility with older z.ai wiring.

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
