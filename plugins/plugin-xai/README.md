# @elizaos/plugin-xai

xAI Grok models for elizaOS — text generation and embeddings.

Registers Grok as the `TEXT_SMALL`, `TEXT_LARGE`, and `TEXT_EMBEDDING` model
handlers in an Eliza agent runtime. The plugin is **auto-enabled** when
`XAI_API_KEY` (or the alias `GROK_API_KEY`) is present. It adds no actions,
providers, or services — purely model handlers.

For X (formerly Twitter) social posting, mentions, and timeline interactions,
use [`@elizaos/plugin-x`](../plugin-x) instead. This package is
intentionally Grok-only.

## Installation

```bash
bun add @elizaos/plugin-xai
```

## Capabilities

| Capability       | Model type registered | Default model   |
| ---------------- | --------------------- | --------------- |
| Text (large)     | `TEXT_LARGE`          | `grok-3`        |
| Text (small)     | `TEXT_SMALL`          | `grok-3-mini`   |
| Embeddings       | `TEXT_EMBEDDING`      | `grok-embedding`|

Streaming (`stream: true` + `onStreamChunk`) is supported for both text model
types. Tool calling (`tools`, `toolChoice`) and structured output
(`responseSchema`) are handled natively via the xAI OpenAI-compatible API.

## Configuration

Set `XAI_API_KEY` and (optionally) override the defaults:

| Variable              | Default               | Description                                      |
| --------------------- | --------------------- | ------------------------------------------------ |
| `XAI_API_KEY`         | —                     | **Required.** xAI API key.                       |
| `GROK_API_KEY`        | —                     | Alias recognized by auto-enable only; runtime model calls require `XAI_API_KEY`. |
| `XAI_MODEL`           | `grok-3`              | Large/default text model. Also accepts `XAI_LARGE_MODEL`. |
| `XAI_SMALL_MODEL`     | `grok-3-mini`         | Smaller/faster text model.                       |
| `XAI_EMBEDDING_MODEL` | `grok-embedding`      | Embedding model.                                 |
| `XAI_BASE_URL`        | `https://api.x.ai/v1` | API base URL (useful for proxies or local mocks).|

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

The plugin is auto-enabled when `XAI_API_KEY` is set in the environment, so
explicit registration in `plugins` is only required when auto-enable is bypassed.

## Development

```bash
bun run --cwd plugins/plugin-xai build
bun run --cwd plugins/plugin-xai test
bun run --cwd plugins/plugin-xai typecheck
```
