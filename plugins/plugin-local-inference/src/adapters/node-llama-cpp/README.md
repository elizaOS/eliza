# Local AI Plugin

This plugin is the legacy `local-ai` compatibility provider. New Eliza-1 local
inference installs should use `@elizaos/plugin-local-inference`, which owns the
canonical Eliza-1 bundle catalog, downloads, routing, fused text/voice runtime,
and readiness checks. When an active local-inference backend is registered,
`plugin-local-ai` routes supported model calls through it first and only falls
back to its legacy direct-model paths when the unified backend is unavailable.

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

# Optional: Specify filenames for legacy direct GGUF loading within the models directory
# LOCAL_SMALL_MODEL=text/eliza-1-2b-32k.gguf
# LOCAL_LARGE_MODEL=text/eliza-1-4b-64k.gguf
# LOCAL_EMBEDDING_MODEL=text/eliza-1-0_8b-32k.gguf

# Optional: Fallback dimension size for embeddings if generation fails. Defaults to the model's default (e.g., 1024).
# LOCAL_EMBEDDING_DIMENSIONS=1024

# Optional legacy compatibility only:
# LOCAL_AI_LEGACY_TTS_MODEL=<transformers.js text-to-audio model id>
# LOCAL_AI_LEGACY_TTS_SPEAKER_EMBEDDING_URL=<speaker embedding URL>
# LOCAL_AI_ENABLE_LEGACY_WHISPER=1
# LOCAL_AI_ENABLE_LEGACY_VISION=1
```

### Configuration Options

- `MODELS_DIR` (Optional): Specifies a custom directory for storing model files (GGUF format). If not set, defaults to `~/.eliza/models`.
- `CACHE_DIR` (Optional): Specifies a custom directory for caching other components like tokenizers. If not set, defaults to `~/.eliza/cache`.
- `LOCAL_SMALL_MODEL` (Optional): Specifies the legacy direct-load small text generation model. Defaults to `text/eliza-1-2b-32k.gguf`.
- `LOCAL_LARGE_MODEL` (Optional): Specifies the legacy direct-load large text generation model. Defaults to `text/eliza-1-4b-64k.gguf`.
- `LOCAL_EMBEDDING_MODEL` (Optional): Specifies the legacy direct-load text embedding model. Defaults to `text/eliza-1-0_8b-32k.gguf`.
- `LOCAL_EMBEDDING_DIMENSIONS` (Optional): Defines the expected dimension size for text embeddings. This is primarily used as a fallback dimension if the embedding model fails to generate an embedding. If not set, it defaults to the embedding model's native dimension size (1024).
- `LOCAL_AI_LEGACY_TTS_MODEL` (Optional, legacy only): Enables the old Transformers.js TTS path with an explicit model id. There is no default local TTS model in this plugin; canonical Eliza-1 TTS is served by `@elizaos/plugin-local-inference`.
- `LOCAL_AI_ENABLE_LEGACY_WHISPER` (Optional, legacy only): Set to `1`, `true`, or `yes` to allow the old `whisper-node` transcription fallback when no local-inference backend is active. Canonical Eliza-1 ASR is served by `@elizaos/plugin-local-inference`.
- `LOCAL_AI_ENABLE_LEGACY_VISION` (Optional, legacy only): Set to `1`, `true`, or `yes` to allow the old Florence/Transformers.js image-description fallback when no local-inference backend is active. Canonical Eliza-1 vision is served by `@elizaos/plugin-local-inference`.
- `LOCAL_AI_TEST_MODEL_PATH` (Optional, tests only): Absolute path to a GGUF model file used by the gated integration tests in `__tests__/integration.test.ts`. The integration tests are skipped unless this is set.

## Features

The plugin provides these model classes:

- `TEXT_SMALL`: Routes to local-inference when available; otherwise uses the legacy Eliza-1 2B GGUF path.
- `TEXT_LARGE`: Routes to local-inference when available; otherwise uses the legacy Eliza-1 4B GGUF path.
- `TEXT_EMBEDDING`: Routes to local-inference when available; otherwise uses the legacy Eliza-1 0_8B embedding path.
- `IMAGE_DESCRIPTION`: Routes to local-inference. The old Florence/Transformers.js fallback is opt-in via `LOCAL_AI_ENABLE_LEGACY_VISION=1`.
- `TEXT_TO_SPEECH`: Routes to local-inference. The old Transformers.js fallback is opt-in via `LOCAL_AI_LEGACY_TTS_MODEL`.
- `TRANSCRIPTION`: Routes to local-inference. The old Whisper fallback is opt-in via `LOCAL_AI_ENABLE_LEGACY_WHISPER=1`.

### Native tool calling and structured output

`TEXT_SMALL` and `TEXT_LARGE` route `tools`, `responseSchema`, and
`responseFormat: { type: "json_object" }` through `node-llama-cpp`'s native
function-calling and grammar-constrained-output APIs. When any of these are
set the handler returns `{ text, toolCalls, finishReason? }` (matching the
shape used by `plugin-openai` and `plugin-anthropic`) instead of a plain
string.

Tool calling works best on the Eliza-1 chat tiers shipped through the local
catalog. Smaller local models without tool-call training may refuse to emit
tool calls — pass a larger Eliza-1 tier or drop the `tools` field.

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
