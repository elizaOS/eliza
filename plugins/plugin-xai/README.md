# @elizaos/plugin-xai

xAI Grok models for elizaOS — text generation and embeddings.

For X (formerly Twitter) social posting, mentions, and timeline interactions,
use [`@elizaos/plugin-x`](../plugin-x) instead. This package is
intentionally Grok-only.

## Installation

```bash
bun add @elizaos/plugin-xai
```

## Usage

```typescript
import { XAIPlugin } from "@elizaos/plugin-xai";
import { AgentRuntime, ModelType } from "@elizaos/core";

const runtime = new AgentRuntime({
  plugins: [XAIPlugin],
});

const text = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Explain quantum computing",
});
```

## Configuration

Set `XAI_API_KEY` and (optionally) override defaults:

| Variable              | Default              | Description                         |
| --------------------- | -------------------- | ----------------------------------- |
| `XAI_API_KEY`         | —                    | Required. xAI API key.              |
| `XAI_MODEL`           | `grok-3`             | Large/default text-generation model. |
| `XAI_SMALL_MODEL`     | `grok-3-mini`        | Smaller/faster text model.           |
| `XAI_EMBEDDING_MODEL` | `grok-embedding`     | Embedding model.                     |
| `XAI_BASE_URL`        | `https://api.x.ai/v1`| API base URL.                        |

## Development

```bash
bun run build
bun run test
bun run typecheck
```
