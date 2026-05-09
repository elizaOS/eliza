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
- `LOCAL_AI_TEST_MODEL_PATH` (Optional, tests only): Absolute path to a GGUF model file used by the gated integration tests in `__tests__/integration.test.ts`. The integration tests are skipped unless this is set.

## Features

The plugin provides these model classes:

- `TEXT_SMALL`: Fast, efficient text generation using smaller models
- `TEXT_LARGE`: More capable text generation using larger models
- `TEXT_EMBEDDING`: Generates text embeddings locally.
- `IMAGE_DESCRIPTION`: Local image analysis using Florence-2 vision model
- `TEXT_TO_SPEECH`: Local text-to-speech synthesis
- `TRANSCRIPTION`: Local audio transcription using Whisper

### Native tool calling and structured output

`TEXT_SMALL` and `TEXT_LARGE` route `tools`, `responseSchema`, and
`responseFormat: { type: "json_object" }` through `node-llama-cpp`'s native
function-calling and grammar-constrained-output APIs. When any of these are
set the handler returns `{ text, toolCalls, finishReason? }` (matching the
shape used by `plugin-openai` and `plugin-anthropic`) instead of a plain
string.

Tool calling works best on models with a known chat template. Verified
families (in `node-llama-cpp` 3.x): Llama 3 / 3.1 / 3.2, Functionary, Hermes
2 Pro / DeepHermes, Qwen 2.5, Mistral Nemo, DeepSeek, Gemma. Smaller base
models without tool-call training may refuse to emit tool calls — pass a
larger model or drop the `tools` field.

```typescript
const result = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "What's the weather in Paris?",
  tools: [
    {
      name: "get_weather",
      description: "Look up weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
});
// result.toolCalls -> [{ id, name: "get_weather", arguments: { city: "Paris" }, type: "function" }]
```

### Prompt cache reuse

The plugin keeps one long-lived `LlamaContext` + `LlamaChatSession` per
model type (`TEXT_SMALL` / `TEXT_LARGE`). Successive `useModel` calls reuse
the existing KV cache — there is no per-call context teardown, so the
system-prompt prefix stays evaluated. The session is dropped only when the
system prompt changes for that model type.

This mirrors what `plugin-anthropic` does with `cache_control` and what
`plugin-openai` does with stable system prompts: the prefix is paid for
once, subsequent turns extend the cache instead of rebuilding it.

### Text Generation

```typescript
// Using small model
const smallResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Generate a short response",
  stopSequences: [],
});

// Using large model
const largeResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Generate a detailed response",
  stopSequences: [],
});
```

### Text Embedding

```typescript
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Text to get embedding for",
});
```

### Image Analysis

```typescript
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  "https://example.com/image.jpg",
);
```

### Text-to-Speech

```typescript
const audioStream = await runtime.useModel(
  ModelType.TEXT_TO_SPEECH,
  "Text to convert to speech",
);
```

### Audio Transcription

```typescript
const transcription = await runtime.useModel(
  ModelType.TRANSCRIPTION,
  audioBuffer,
);
```
