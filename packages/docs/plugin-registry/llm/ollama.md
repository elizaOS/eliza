---
title: "Ollama Plugin"
sidebarTitle: "Ollama"
description: "Ollama local model inference for Eliza — run Llama, Mistral, Gemma, and other models entirely on-device."
---

The Ollama plugin connects Eliza agents to a locally running Ollama instance, enabling fully on-device inference with no API keys and no data leaving your machine.

**Package:** `@elizaos/plugin-ollama`

## Installation

### 1. Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS (Homebrew)
brew install ollama
```

### 2. Pull a Model

```bash
ollama pull gemma3
# or
ollama pull llama3.3
# or
ollama pull mistral
```

### 3. Start Ollama

```bash
ollama serve
```

Ollama listens on `http://localhost:11434` by default.

### 4. Enable the Plugin

```bash
eliza plugins install @elizaos/plugin-ollama
```

## Auto-Enable

The plugin auto-enables when `OLLAMA_API_ENDPOINT` or `OLLAMA_BASE_URL` is present:

```bash
export OLLAMA_API_ENDPOINT=http://localhost:11434
# or
export OLLAMA_BASE_URL=http://localhost:11434
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OLLAMA_API_ENDPOINT` | Yes | Ollama server URL (e.g., `http://localhost:11434`) |
| `OLLAMA_BASE_URL` | No | Alias for convenience (resolved to `OLLAMA_API_ENDPOINT`) |
| `OLLAMA_SMALL_MODEL` | No | Override the small model identifier |
| `OLLAMA_MEDIUM_MODEL` | No | Override the medium model identifier |
| `OLLAMA_LARGE_MODEL` | No | Override the large model identifier |
| `OLLAMA_EMBEDDING_MODEL` | No | Override the embedding model identifier |
| `OLLAMA_DISABLE_STRUCTURED_OUTPUT` | No | Set to `1`, `true`, `yes`, or `on` to disable JSON-schema structured text if a local model misbehaves with Ollama `format` requests |
| `SMALL_MODEL` | No | Global alias to override the small model identifier |
| `LARGE_MODEL` | No | Global alias to override the large model identifier |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "ollama",
        "model": "llama3.3"
      }
    }
  }
}
```

## Supported Models

Any model available in the Ollama library works. Common choices:

| Model | Parameters | Context | Best For |
|-------|-----------|---------|---------|
| `llama3.3` | 70B | 128k | General purpose |
| `llama3.2` | 3B / 1B | 128k | Fast, lightweight |
| `mistral` | 7B | 32k | Efficient reasoning |
| `mixtral` | 8x7B | 32k | Code and analysis |
| `gemma3` | 4B / 12B / 27B | 128k | Instruction following |
| `qwen2.5` | 7B / 14B / 32B | 128k | Multilingual |
| `phi4` | 14B | 16k | Microsoft Phi series |
| `deepseek-r1` | 7B–70B | 128k | Reasoning |
| `nomic-embed-text` | — | — | Embeddings |

Browse all available models at [ollama.com/library](https://ollama.com/library).

## Model Type Mapping

| elizaOS Model Type | Default Ollama Model |
|-------------------|---------------------|
| `TEXT_SMALL` | `gemma3:latest` |
| `TEXT_LARGE` | `gemma3:latest` |
| `TEXT_EMBEDDING` | `nomic-embed-text` |
| `IMAGE_DESCRIPTION` | `llava` (if installed) |

Override defaults via environment variables or in your auth profile:

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "ollama",
        "model": "llama3.3",
        "modelSmall": "gemma3:4b"
      }
    }
  }
}
```

## Features

- Fully local — no API keys, no network calls
- Compatible with OpenAI API format
- GPU acceleration (NVIDIA CUDA, Apple Metal, AMD ROCm)
- Streaming responses
- Function calling (model-dependent)
- Vision input (llava, gemma3 multimodal variants)

## Hardware Requirements

| Model Size | RAM Required | GPU VRAM |
|-----------|-------------|---------|
| 7B | 8 GB | 6 GB |
| 13B | 16 GB | 10 GB |
| 34B | 32 GB | 24 GB |
| 70B | 64 GB | 48 GB |

Models run on CPU if insufficient VRAM is available, but with reduced speed.

## Remote Ollama

Ollama can run on a remote machine or NAS. Set `OLLAMA_API_ENDPOINT` to the remote address:

```bash
export OLLAMA_API_ENDPOINT=http://192.168.1.100:11434
```

Secure with a reverse proxy (Nginx + TLS) for production.

## Troubleshooting

### "Unsupported model version v1" Error

**Symptoms:** Agent crashes or silently fails on first chat. Terminal shows:

```
Error: Unsupported model version v1
```

**Cause:** Older builds used `ollama-ai-provider` (v1 model spec) with AI SDK 5+, which requires providers that implement specification v2. Current `@elizaos/plugin-ollama` uses `ollama-ai-provider-v2`, which matches AI SDK 5/6. If you still see this error, run `bun install` at the repo root so dependencies resolve to the updated provider.

**Alternative — Use Ollama's OpenAI-Compatible Endpoint:**

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1`. Route through the OpenAI plugin instead:

```json5
// ~/.eliza/eliza.json
{
  env: {
    OPENAI_API_KEY: "ollama",                        // any non-empty string
    OPENAI_BASE_URL: "http://localhost:11434/v1",     // ollama's openai-compat endpoint
    SMALL_MODEL: "gemma3:4b",                        // your pulled model
    LARGE_MODEL: "gemma3:4b",
  },
}
```

This bypasses `plugin-ollama` entirely and uses `plugin-openai` with your local Ollama instance. Use it only when you specifically want Ollama's OpenAI-compatible route instead of the native Ollama adapter.

### Ollama Not Detected

If Eliza doesn't detect your Ollama instance:

1. Verify Ollama is running: `curl http://localhost:11434/api/tags`
2. Check you have models pulled: `ollama list`
3. If using a non-default port, set `OLLAMA_API_ENDPOINT` accordingly

### Slow Responses

- Check available RAM/VRAM — models running on CPU are significantly slower
- Try a smaller model: `gemma3:4b` or `llama3.2:3b`
- Close other GPU-intensive applications

## Related

- [Groq Plugin](/plugin-registry/llm/groq) — Fast cloud inference for Llama models
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Multi-provider gateway
- [Model Providers](/runtime/models) — Compare all providers
