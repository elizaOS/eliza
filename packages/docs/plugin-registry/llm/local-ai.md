---
title: "Local AI Plugin"
sidebarTitle: "Local AI"
description: "Local AI model provider for Eliza — self-hosted, OpenAI-compatible local inference with GGUF models."
---

The Local AI plugin enables Eliza agents to run inference entirely on-device using GGUF model files, with no external API keys required.

**Package:** `@elizaos/plugin-local-ai`

## Installation

```bash
eliza plugins install local-ai
```

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `LOCAL_LARGE_MODEL` | No | `text/eliza-1-9b-64k.gguf` | Filename of the large local model |
| `LOCAL_SMALL_MODEL` | No | `text/eliza-1-2b-32k.gguf` | Filename of the small local model |
| `LOCAL_EMBEDDING_MODEL` | No | `text/eliza-1-0_8b-32k.gguf` | Filename of the embedding model |
| `LOCAL_EMBEDDING_DIMENSIONS` | No | `1024` | Number of embedding dimensions |
| `MODELS_DIR` | No | — | Directory where model files are stored |
| `CACHE_DIR` | No | — | Cache directory for model assets |
| `CUDA_VISIBLE_DEVICES` | No | — | GPU device selection for CUDA acceleration |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "local-ai"
      }
    }
  }
}
```

## Model Type Mapping

| elizaOS Model Type | Default Model |
|-------------------|--------------|
| `TEXT_SMALL` | `text/eliza-1-2b-32k.gguf` |
| `TEXT_LARGE` | `text/eliza-1-9b-64k.gguf` |
| `TEXT_EMBEDDING` | `text/eliza-1-0_8b-32k.gguf` |

## Features

- Fully local — no API keys, no network calls
- GGUF model format support
- GPU acceleration when CUDA is available
- Configurable model paths and cache directories
- Separate small and large model selection

## Local AI vs Ollama

| | Local AI | Ollama |
|---|---|---|
| Model format | GGUF files (direct) | Ollama model registry |
| Setup | Place model files in directory | `ollama pull <model>` |
| Server | Built-in to the plugin | Separate Ollama process |
| API key trigger | None (loads when configured as provider) | `OLLAMA_BASE_URL` |

Use Local AI when you want to run GGUF models directly without an external model server. Use Ollama when you want a managed model runtime with easy model downloads.

## Related

- [Ollama Plugin](/plugin-registry/llm/ollama) — Local inference via Ollama server
- [OpenAI Plugin](/plugin-registry/llm/openai) — Cloud-based GPT models
- [Model Providers](/runtime/models) — Compare all providers
