---
title: "Local Models"
sidebarTitle: "Local Models"
description: "Download and run AI models locally for offline inference."
---

Milady can download and run AI models locally for vision, text generation, text-to-speech, speech-to-text, and embedding tasks. Models are downloaded from HuggingFace or pulled via Ollama, cached on disk, and available for offline use.

## Model Types

| Type | Purpose | Example Models |
|------|---------|---------------|
| `vision` | Image captioning and analysis | BLIP, Florence-2, Moondream2 |
| `llm` | Text generation (via Ollama) | Llama 3.2, Qwen 2.5, Phi-3 |
| `tts` | Text-to-speech | Parler TTS, Bark, SpeechT5 |
| `stt` | Speech-to-text | Whisper (tiny through medium) |
| `embedding` | Text embeddings | MiniLM, BGE, Nomic Embed |

## Available Models

### Vision Models

| ID | Name | Size | Format |
|----|------|------|--------|
| `Salesforce/blip-image-captioning-base` | BLIP Caption (Base) | 990 MB | ONNX |
| `Salesforce/blip-image-captioning-large` | BLIP Caption (Large) | 1.9 GB | ONNX |
| `microsoft/Florence-2-base` | Florence-2 (Base) | 460 MB | — |
| `vikhyatk/moondream2` | Moondream2 (Tiny Vision LLM) | 3.6 GB | Ollama |

### LLM Models (via Ollama)

| ID | Name | Size |
|----|------|------|
| `ollama/llama3.2:1b` | Llama 3.2 1B (Tiny) | 1.3 GB |
| `ollama/llama3.2:3b` | Llama 3.2 3B (Small) | 2 GB |
| `ollama/qwen2.5:0.5b` | Qwen 2.5 0.5B (Micro) | 400 MB |
| `ollama/phi3:mini` | Phi-3 Mini (3.8B) | 2.3 GB |

### Text-to-Speech Models

| ID | Name | Size | Format |
|----|------|------|--------|
| `parler-tts/parler-tts-mini-v1` | Parler TTS Mini | 2.4 GB | — |
| `suno/bark-small` | Bark Small | 1.5 GB | — |
| `microsoft/speecht5_tts` | SpeechT5 TTS | 600 MB | ONNX |

### Speech-to-Text Models

| ID | Name | Size | Format |
|----|------|------|--------|
| `openai/whisper-tiny` | Whisper Tiny | 150 MB | ONNX |
| `openai/whisper-base` | Whisper Base | 290 MB | ONNX |
| `openai/whisper-small` | Whisper Small | 970 MB | ONNX |
| `openai/whisper-medium` | Whisper Medium | 3.1 GB | ONNX |

### Embedding Models

| ID | Name | Size | Format |
|----|------|------|--------|
| `sentence-transformers/all-MiniLM-L6-v2` | MiniLM L6 v2 (Fast) | 90 MB | ONNX |
| `BAAI/bge-small-en-v1.5` | BGE Small EN | 130 MB | ONNX |
| `nomic-ai/nomic-embed-text-v1.5` | Nomic Embed v1.5 | 270 MB | ONNX |

## Storage

Models are cached at `~/.cache/milady/models/`. A `manifest.json` file tracks all downloaded models:

```json
{
  "Salesforce/blip-image-captioning-base": {
    "downloadedAt": "2026-01-15T10:00:00.000Z",
    "path": "/Users/name/.cache/milady/models/Salesforce_blip-image-captioning-base"
  },
  "ollama/llama3.2:1b": {
    "downloadedAt": "2026-01-15T10:00:00.000Z",
    "path": "ollama:llama3.2:1b"
  }
}
```

## Download Behavior

### HuggingFace Models

For non-Ollama models, the manager fetches the file list from `https://huggingface.co/api/models/<modelId>`, filters to essential files (config, tokenizer, model weights in `.bin`, `.safetensors`, or `.onnx` format), and downloads each file.

### Ollama Models

For models with an Ollama tag (e.g., `ollama/llama3.2:1b`), the manager calls `POST http://localhost:11434/api/pull` with the model name. Requires a running Ollama server.

## Management

Local models are managed through the dashboard or the CLI:

```bash
milady models              # show model provider status and local models
```

Models can also be managed through the REST API endpoints at `/api/models`.

## Related

- [Model Providers](/model-providers) — all inference backends
- [Local AI Plugin](/plugin-registry/llm/local-ai) — embedded GGUF inference without an Ollama server
- [Ollama Plugin](/plugin-registry/llm/ollama) — local inference via a running Ollama server
- [Environment variables](/cli/environment) — `OLLAMA_API_ENDPOINT`, `LOCAL_EMBEDDING_*`
- [`milady models`](/cli/models) — check configured providers
