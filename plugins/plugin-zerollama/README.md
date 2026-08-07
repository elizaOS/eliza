# @elizaos/plugin-zerollama

First-party elizaOS model provider for a local or self-hosted
[Ollama](https://ollama.com/) compatible server. It supports text generation,
streaming, tool calls, structured output, embeddings, and opt-in OpenAI-style
speech and transcription endpoints. A zerollama server is detected from
`GET /api/version`; stock Ollama remains supported through the AI SDK adapter.

## Requirements

- Bun 1.3.14 / Node 24.15.0, as pinned by this repository.
- An Ollama-compatible HTTP server reachable by the agent process.
- At least one installed text model. Missing requested models are pulled by the
  server before their first call.

## Configuration

Set one endpoint variable. Values with or without the trailing `/api` are
accepted:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_SMALL_MODEL=qwen3:0.6b
export OLLAMA_LARGE_MODEL=qwen3:0.6b
export OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

Endpoint precedence is `OLLAMA_API_ENDPOINT`, `OLLAMA_API_URL`, then
`OLLAMA_BASE_URL`. Any of those variables auto-enables the plugin. A character
may also list `@elizaos/plugin-zerollama` explicitly.

Common model overrides:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OLLAMA_NANO_MODEL` | nano-tier text | small model |
| `OLLAMA_SMALL_MODEL` | small-tier text | `eliza-1-2b` |
| `OLLAMA_MEDIUM_MODEL` | medium-tier text | small model |
| `OLLAMA_LARGE_MODEL` | large-tier text | `eliza-1-4b` |
| `OLLAMA_MEGA_MODEL` | mega-tier text | large model |
| `OLLAMA_EMBEDDING_MODEL` | embeddings | `eliza-1-2b` |
| `OLLAMA_HOST_FLAVOR` | force `ollama` or `zerollama` | auto-detected |

## Voice endpoints

Voice handlers are registered but remain unavailable until their model setting
is explicit. This prevents a text-only Ollama installation from advertising
speech capabilities it cannot serve.

```bash
export OLLAMA_TTS_MODEL=piper-lessac:latest
export OLLAMA_TTS_VOICE=en_US-lessac-medium
export OLLAMA_TRANSCRIPTION_MODEL=whisper-base
```

TTS calls `POST /v1/audio/speech`; transcription calls
`POST /v1/audio/transcriptions`. Caller-supplied transcription URLs are fetched
through the core SSRF guard and are capped at 25 MiB. `voice`, `speed`, `model`,
and cancellation signals are forwarded per request.

## Relationship to local inference

This plugin talks to an external Ollama-compatible HTTP daemon. It is distinct
from `@elizaos/plugin-local-inference`, which runs models in-process through the
fused `libelizainference` runtime. Both may be installed; the runtime's typed
provider routing and preference policy decides which handler serves each model
type.

## Development

```bash
bun run --cwd packages/core build
bun run --cwd plugins/plugin-zerollama test
bun run --cwd plugins/plugin-zerollama typecheck
bun run --cwd plugins/plugin-zerollama lint:check
bun run --cwd plugins/plugin-zerollama build
```

The deterministic unit suite mocks the HTTP boundary. Release evidence must
also exercise completion, streaming, tool calling, structured output, failure,
and any configured voice endpoint against a real server.
