---
title: "Ollama Plugin"
sidebarTitle: "Ollama"
description: "Ollama local model inference for Eliza — run Eliza-1 models entirely on-device."
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

### 2. Create an Eliza-1 Model

```bash
ollama create eliza-1-2b -f packages/training/cloud/ollama/Modelfile.eliza-1-2b-q4_k_m
ollama create eliza-1-9b -f packages/training/cloud/ollama/Modelfile.eliza-1-9b-q4_k_m
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
        "model": "eliza-1-9b"
      }
    }
  }
}
```

## Supported Models

Eliza local support is centered on the Eliza-1 Ollama Modelfiles published from
the training pipeline:

| Model | Purpose |
|-------|---------|
| `eliza-1-2b` | Fast local default and embedding fallback |
| `eliza-1-9b` | Higher-quality local text generation |
| `eliza-1-27b` | Workstation/server local text generation |

## Model Type Mapping

| elizaOS Model Type | Default Ollama Model |
|-------------------|---------------------|
| `TEXT_SMALL` | `eliza-1-2b` |
| `TEXT_LARGE` | `eliza-1-9b` |
| `TEXT_EMBEDDING` | `eliza-1-2b` |

Override defaults via environment variables or in your auth profile:

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "ollama",
        "model": "eliza-1-9b",
        "modelSmall": "eliza-1-2b"
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

## Hardware Requirements

| Model | RAM Required | GPU VRAM |
|-------|-------------|---------|
| `eliza-1-2b` | 8 GB | 4 GB |
| `eliza-1-9b` | 24 GB | 12 GB |
| `eliza-1-27b` | 64 GB | 48 GB |

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
    SMALL_MODEL: "eliza-1-2b",
    LARGE_MODEL: "eliza-1-9b",
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
- Try `eliza-1-2b` before moving up to `eliza-1-9b`
- Close other GPU-intensive applications

## Related

- [Groq Plugin](/plugin-registry/llm/groq) — Fast cloud inference with GPT-OSS 120B
- [OpenRouter Plugin](/plugin-registry/llm/openrouter) — Multi-provider gateway
- [Model Providers](/runtime/models) — Compare all providers
