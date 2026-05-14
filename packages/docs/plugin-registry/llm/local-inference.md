---
title: "Local Inference Plugin"
sidebarTitle: "Local Inference"
description: "Unified Eliza-1 local inference provider — text, embeddings, voice, and image description via node-llama-cpp + ONNX."
---

The Local Inference plugin is the canonical on-device AI provider for Eliza. It runs Eliza-1 GGUF models entirely on your machine — no external API, no cloud — and serves every local model surface from a single plugin:

- **TEXT_SMALL / TEXT_LARGE** — Eliza-1 fine-tunes via `node-llama-cpp`
- **TEXT_EMBEDDING** — vector embeddings for memory + semantic search
- **TEXT_TO_SPEECH** — Kokoro local TTS
- **TRANSCRIPTION** — Whisper ASR via ONNX
- **IMAGE_DESCRIPTION** — local vision (Florence/Transformers.js)

**Package:** `@elizaos/plugin-local-inference`

> This plugin replaces the deprecated `@elizaos/plugin-local-ai` (text + legacy vision/Whisper) and `@elizaos/plugin-local-embedding` (embeddings shim). All three model surfaces are now served from a single unified provider — see [the consolidation plan](/docs/migrations/eliza-submodule-removal) for migration notes.

## Installation

This plugin is a core plugin (registered in `CORE_PLUGINS`) and is always loaded on desktop runtimes. No manual installation is required.

On Android (elizaOS-only), set `ELIZA_LOCAL_LLAMA=1` to also enable the in-process `bun:ffi` loader provided by the companion plugin `@elizaos/plugin-aosp-local-inference`.

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `MODELS_DIR` | No | `~/.milady/models` | Directory where GGUF model files are stored |
| `CACHE_DIR` | No | `~/.milady/cache` | Cache directory for tokenizers / ONNX models |
| `LOCAL_SMALL_MODEL` | No | `text/eliza-1-2b-32k.gguf` | Filename of the small model (TEXT_SMALL handler) |
| `LOCAL_LARGE_MODEL` | No | `text/eliza-1-4b-64k.gguf` | Filename of the large model (TEXT_LARGE handler) |
| `LOCAL_EMBEDDING_MODEL` | No | `text/eliza-1-0_8b-32k.gguf` | Filename of the embedding model |
| `LOCAL_EMBEDDING_DIMENSIONS` | No | `1024` | Number of embedding dimensions |
| `CUDA_VISIBLE_DEVICES` | No | — | Restrict which CUDA GPUs the runtime sees |
| `ELIZA_LOCAL_LLAMA` | No | — | Set to `1` on Android to enable the AOSP FFI loader |

### eliza.json Example

```json
{
  "plugins": ["@elizaos/plugin-local-inference"],
  "settings": {
    "LOCAL_SMALL_MODEL": "text/eliza-1-2b-32k.gguf",
    "LOCAL_LARGE_MODEL": "text/eliza-1-4b-64k.gguf"
  }
}
```

## How it works

The plugin ships a unified provider that dispatches each `ModelType` request to the appropriate backend:

- On desktop / iOS, `node-llama-cpp` loads the GGUF directly into the agent process (optional dependency — install fails open if the platform has no prebuild).
- On Android (`ELIZA_LOCAL_LLAMA=1`), the `@elizaos/plugin-aosp-local-inference` FFI bridge is loaded lazily and binds to `libllama.so` + `libeliza-llama-shim.so` via `bun:ffi`.
- Voice handlers (Kokoro TTS, Whisper ASR, VAD, wake-word) live alongside the text handlers in the same plugin and share its model catalog + download manager.

The native `llama.cpp` fork (with Eliza kernels — Q4_POLAR / QJL1_256 / TBQ4_0 / TBQ3_0 + DFlash spec-decode) is checked out as a submodule under `plugins/plugin-local-inference/native/llama.cpp` and built on demand by the host build script.

## Related

- [Memory Plugin](/plugin-registry/documents) — Memory & semantic retrieval (consumes `TEXT_EMBEDDING`).
- [Anthropic Plugin](/plugin-registry/llm/anthropic) — Cloud LLM provider, alternative to local inference.
- [Ollama Plugin](/plugin-registry/llm/ollama) — Local inference via an external Ollama daemon.
- [LM Studio Plugin](/plugin-registry/llm/lmstudio) — Local inference via the LM Studio desktop app.
- [MLX Plugin](/plugin-registry/llm/mlx) — Local inference via Apple's `mlx_lm.server` (Apple Silicon).
