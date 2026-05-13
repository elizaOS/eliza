---
title: "Local Models"
sidebarTitle: "Local Models"
description: "Download and run AI models locally for offline inference."
---

Eliza can download and run Eliza-1 GGUF models locally for text generation and embedding. Models are downloaded from HuggingFace or created for Ollama from the Eliza-1 Modelfiles, cached on disk, and available for offline use.

## Model Types

| Type | Purpose | Example Models |
|------|---------|---------------|
| `llm` | Text generation | Eliza-1 mobile, desktop, pro |
| `tts` | Text-to-speech | Parler TTS, Bark, SpeechT5 |
| `stt` | Speech-to-text | Whisper (tiny through medium) |
| `embedding` | Text embeddings | Eliza-1 lite |

## Available Models

### Eliza-1 GGUF Models

| ID | Name | Size |
|----|------|------|
| `elizaos/eliza-1-0_8b` | Eliza-1 Lite Embedding | varies |
| `elizaos/eliza-1-2b` | Eliza-1 Mobile Chat | varies |
| `elizaos/eliza-1-9b` | Eliza-1 Desktop Chat | varies |
| `elizaos/eliza-1-27b` | Eliza-1 Pro Chat | varies |

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

## Storage

Models are cached at `~/.cache/eliza/models/`. A `manifest.json` file tracks all downloaded models:

```json
{
  "Salesforce/blip-image-captioning-base": {
    "downloadedAt": "2026-01-15T10:00:00.000Z",
    "path": "/Users/name/.cache/eliza/models/Salesforce_blip-image-captioning-base"
  },
  "elizaos/eliza-1-2b": {
    "downloadedAt": "2026-01-15T10:00:00.000Z",
    "path": "/Users/name/.cache/eliza/models/elizalabs_eliza-1-2b/text/eliza-1-2b-32k.gguf"
  }
}
```

## Download Behavior

### HuggingFace Models

The manager fetches the file list from `https://huggingface.co/api/models/<modelId>`, filters to published Eliza-1 GGUF files, and downloads only the files needed for the selected tier.

### Ollama Models

For Ollama, create the Eliza-1 model from the repo Modelfiles in `packages/training/cloud/ollama/`. Requires a running Ollama server.

## Management

Local models are managed through the dashboard or the CLI:

```bash
eliza models              # show model provider status and local models
```

Models can also be managed through the REST API endpoints at `/api/models`.

## Related

- [Model Providers](/model-providers) — all inference backends
- [Local AI Plugin](/plugin-registry/llm/local-ai) — embedded GGUF inference without an Ollama server
- [Ollama Plugin](/plugin-registry/llm/ollama) — local inference via a running Ollama server
- [Environment variables](/cli/environment) — `OLLAMA_API_ENDPOINT`, `LOCAL_EMBEDDING_*`
- [`eliza models`](/cli/models) — check configured providers
