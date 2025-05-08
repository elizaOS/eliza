# Local AI Plugin

This plugin provides local AI model capabilities through the ElizaOS platform, supporting text generation, image analysis, speech synthesis, and audio transcription.

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-local-ai"]
```

## Configuration

The plugin is configured using environment variables (typically set in a `.env` file or via your deployment settings):

Or in `.env` file:

```env
# Optional: Specify a custom directory for models (GGUF files)
# MODELS_DIR=/path/to/your/models

# Optional: Specify a custom directory for caching other components (tokenizers, etc.)
# CACHE_DIR=/path/to/your/cache

# Optional: Specify filenames for the text generation and embedding models within the models directory
# LOCAL_SMALL_MODEL=my-custom-small-model.gguf
# LOCAL_LARGE_MODEL=my-custom-large-model.gguf
# LOCAL_EMBEDDING_MODEL=my-custom-embedding-model.gguf

# Optional: Fallback dimension size for embeddings if generation fails. Defaults to the model's default (e.g., 384).
# LOCAL_EMBEDDING_DIMENSIONS=384
```

### Configuration Options

- `MODELS_DIR` (Optional): Specifies a custom directory for storing model files (GGUF format). If not set, defaults to `~/.eliza/models`.
- `CACHE_DIR` (Optional): Specifies a custom directory for caching other components like tokenizers. If not set, defaults to `~/.eliza/cache`.
- `LOCAL_SMALL_MODEL` (Optional): Specifies the filename for the small text generation model (e.g., `DeepHermes-3-Llama-3-3B-Preview-q4.gguf`) located in the models directory.
- `LOCAL_LARGE_MODEL` (Optional): Specifies the filename for the large text generation model (e.g., `DeepHermes-3-Llama-3-8B-q4.gguf`) located in the models directory.
- `LOCAL_EMBEDDING_MODEL` (Optional): Specifies the filename for the text embedding model (e.g., `bge-small-en-v1.5.Q4_K_M.gguf`) located in the models directory.
- `LOCAL_EMBEDDING_DIMENSIONS` (Optional): Defines the expected dimension size for text embeddings. This is primarily used as a fallback dimension if the embedding model fails to generate an embedding. If not set, it defaults to the embedding model's native dimension size (e.g., 384 for `bge-small-en-v1.5.Q4_K_M.gguf`).

## Prerequisites

### FFmpeg for Audio Transcription

The audio transcription feature (`ModelType.TRANSCRIPTION`) relies on **FFmpeg** to process audio files. If FFmpeg is not installed or not found in your system's PATH, transcription will fail.

**Installation:**

- **macOS (using Homebrew):**
  ```bash
  brew install ffmpeg
  ```
- **Linux (Debian/Ubuntu):**
  ```bash
  sudo apt-get update && sudo apt-get install ffmpeg
  ```
- **Linux (Fedora):**
  ```bash
  sudo dnf install ffmpeg
  ```
- **Windows (using Chocolatey):**
  ```bash
  choco install ffmpeg
  ```
  Alternatively, download FFmpeg from the [official FFmpeg website](https://ffmpeg.org/download.html) and add the `bin` directory (containing `ffmpeg.exe`) to your system's PATH environment variable.

After installation, ensure that the `ffmpeg` command is accessible from your terminal. You may need to restart your terminal or your application for the changes to take effect.

## Features

The plugin provides these model classes:

- `TEXT_SMALL`: Fast, efficient text generation using smaller models
- `TEXT_LARGE`: More capable text generation using larger models
- `TEXT_EMBEDDING`: Generates text embeddings locally.
- `IMAGE_DESCRIPTION`: Local image analysis using Florence-2 vision model
- `TEXT_TO_SPEECH`: Local text-to-speech synthesis
- `TRANSCRIPTION`: Local audio transcription using Whisper

### Text Generation

```typescript
// Using small model
const smallResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: 'Generate a short response',
  stopSequences: [],
});

// Using large model
const largeResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: 'Generate a detailed response',
  stopSequences: [],
});
```

### Text-to-Speech

This plugin uses the [`transformers.js`](https://huggingface.co/docs/transformers.js) library for Text-to-Speech synthesis, running directly in the Node.js environment without external Python dependencies for this feature.

```typescript
const audioStream = await runtime.useModel(ModelType.TEXT_TO_SPEECH, 'Text to convert to speech');
```

**Current Implementation Details:**

- **Model:** By default, it uses the [`Xenova/speecht5_tts`](https://huggingface.co/Xenova/speecht5_tts) model (ONNX format), which is optimized for `transformers.js`.
- **Engine:** `@huggingface/transformers` library.
- **Speaker:** It uses a default speaker embedding for `SpeechT5`. The specific voice cannot be configured through environment variables currently.
- **Caching:** The ONNX model files and the default speaker embedding will be automatically downloaded and cached by `transformers.js` (typically in `~/.cache/huggingface/hub` or as configured by `transformers.js` environment variables) on first use.

### Text Embedding

```typescript
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: 'Text to get embedding for',
});
```

### Image Analysis

```typescript
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  'https://example.com/image.jpg'
);
```

### Audio Transcription

```typescript
const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
```
