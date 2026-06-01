# @elizaos/plugin-lmstudio

Connects [LM Studio](https://lmstudio.ai/) to elizaOS agents as a local inference backend via LM Studio's built-in OpenAI-compatible API.

## What it does

This plugin registers text-generation and embedding model handlers for every elizaOS model tier. When active, all agent inference calls (chat, action planning, response handling, embeddings) are routed to a locally-running LM Studio instance instead of a cloud provider.

**Capabilities declared in `package.json`:** `text-large`, `text-small`, `embedding`.

## Auto-enable behavior

The plugin activates automatically when either condition is true:

- `LMSTUDIO_BASE_URL` is set in the environment, **or**
- `http://localhost:1234/v1/models` responds successfully at startup (the default LM Studio port).

No manual plugin registration is needed in the common case.

## Requirements

- [LM Studio](https://lmstudio.ai/) installed and running with its **Local Server** enabled (default port 1234).
- At least one model loaded in LM Studio.
- Node.js 20+ or Bun 1.x. Browser build is included but LM Studio is a local desktop server — browser use requires a CORS-permissive reverse proxy.

## Configuration

All settings are optional. Use environment variables or character/agent settings (`runtime.getSetting`).

| Variable | Default | Description |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio server URL. The plugin appends `/v1` if omitted. |
| `LMSTUDIO_API_KEY` | _(none)_ | Bearer token. Not needed unless LM Studio sits behind an auth proxy. |
| `LMSTUDIO_SMALL_MODEL` | _(auto)_ | Model identifier for small/nano/medium tiers. Falls back to the first model returned by `/v1/models`. |
| `LMSTUDIO_LARGE_MODEL` | _(auto)_ | Model identifier for large/mega/action-planner tiers. Same fallback. |
| `LMSTUDIO_EMBEDDING_MODEL` | _(none)_ | Model identifier for embedding calls. **Required** for memory/recall features. Without it, embeddings return a zero vector. |
| `LMSTUDIO_AUTO_DETECT` | `true` | Set to `0` or `false` to skip the init-time `/v1/models` probe. |

### Example `.env`

```
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_SMALL_MODEL=llama-3.2-3b-instruct
LMSTUDIO_LARGE_MODEL=llama-3.3-70b-instruct
LMSTUDIO_EMBEDDING_MODEL=nomic-embed-text-v1.5
```

## Model tier mapping

| elizaOS tier | Routed to |
|---|---|
| `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM` | `LMSTUDIO_SMALL_MODEL` (or first loaded model) |
| `TEXT_LARGE`, `TEXT_MEGA`, `ACTION_PLANNER` | `LMSTUDIO_LARGE_MODEL` (or first loaded model) |
| `RESPONSE_HANDLER` | `LMSTUDIO_SMALL_MODEL` |
| `TEXT_EMBEDDING` | `LMSTUDIO_EMBEDDING_MODEL` |

## Features

- **Streaming**: enabled by default when `params.stream` is set; streaming is disabled automatically when structured output (JSON schema) is also requested.
- **Structured output**: `responseSchema` is converted to `Output.object` via the Vercel AI SDK.
- **Tool calls**: native tool definitions are normalized and forwarded to the model.
- **Usage tracking**: emits `MODEL_USED` events with token counts (real or estimated) for each call.
- **Graceful degradation**: init-time detection failures are logged but do not crash the agent.

## Installation

```bash
# elizaOS picks it up automatically if LM Studio is running.
# To add it explicitly:
bun add @elizaos/plugin-lmstudio
```

Then reference it in your character file or plugin list:

```json
{
  "plugins": ["@elizaos/plugin-lmstudio"]
}
```
