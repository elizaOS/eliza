# @elizaos/plugin-nearai

First-party NEAR AI Cloud TEE inference provider plugin for elizaOS.

This plugin targets **NEAR AI Cloud's OpenAI-compatible API** and supports:

- `TEXT_SMALL`, `TEXT_LARGE`

## Install

```bash
eliza plugins install @elizaos/plugin-nearai
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NEARAI_API_KEY` | Yes | - | NEAR AI API key |
| `NEARAI_BASE_URL` | No | `https://cloud-api.near.ai/v1` | OpenAI-compatible API base URL |
| `NEARAI_SMALL_MODEL` | No | `Qwen/Qwen3.6-35B-A3B-FP8` | Small model id |
| `NEARAI_LARGE_MODEL` | No | `zai-org/GLM-5.1-FP8` | Large model id |

Model ids come from the public NEAR AI catalog at
`https://cloud-api.near.ai/v1/model/list`. The default models were selected
from TEE-verifiable text models in that catalog.

## Usage

```ts
import { AgentRuntime, ModelType } from "@elizaos/core";
import nearaiPlugin from "@elizaos/plugin-nearai";

const runtime = new AgentRuntime({ plugins: [nearaiPlugin] });

const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a haiku about local-first AI.",
});

console.log(text);
```
