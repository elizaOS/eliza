# @elizaos/plugin-local-inference

Eliza-1 local inference provider for elizaOS. Serves text generation, embeddings, text-to-speech, ASR, image generation, and image description entirely on-device — no network required after model download.

## What it does

- **Text generation** (`TEXT_SMALL`, `TEXT_LARGE`) via an in-process llama.cpp FFI binding. There are two text runtime classes, picked per model by the dispatcher (`services/backend.ts`):
  - **fused Eliza-1 bundles** (`runtimeClass: "fused-eliza1"`) run through the fused `libelizainference` (`desktop-fused-ffi-backend-runtime.ts`) — the full local pipeline: same-file MTP speculative decoding, fork KV kernels (TurboQuant/QJL/PolarQuant), native tokenization over the resident Qwen3.5 vocab, and fused voice/vision. This is the default/recommended path.
  - **generic single-file GGUF** (`runtimeClass: "generic-gguf"`) — a model you downloaded/scanned (Hugging Face / ModelScope / LM Studio / Ollama) loaded from an explicit `modelPath` with stock f16 KV and *reduced optimizations* (no MTP, no fork kernels, no fused voice/vision). The explicit-`modelPath` binding ships on mobile (`llama-cpp-capacitor`); on desktop it is not yet built into the shipping `libelizainference`, so an assigned generic model is rejected at the assignment boundary with a typed reason rather than failing silently at load.
- `node-llama-cpp` has been retired; there is no node-llama-cpp fallback.
- **Text embeddings** (`TEXT_EMBEDDING`) via a dedicated embedding GGUF loaded separately from the chat model.
- **Text-to-speech** (`TEXT_TO_SPEECH`) via the Kokoro TTS engine (ONNX-based, runs locally).
- **Automatic speech recognition** (`TRANSCRIPTION`) via whisper.cpp (GGML-based).
- **Image generation** (`IMAGE`) via sd.cpp, CoreML (Apple Silicon), mflux, TensorRT, or AOSP backends; selected by hardware and catalog entry.
- **Image description / vision** (`IMAGE_DESCRIPTION`) via the Qwen3-VL multimodal projector attached to the active text model.
- **Model catalog, download management, and hardware-fit recommendation** exposed as HTTP routes for the elizaOS dashboard.
- **Voice pipeline**: barge-in, VAD, speaker imprint, phrase streaming, voice profiles, and first-run onboarding.

## Capabilities added to an Eliza agent

| Capability | How it appears |
|---|---|
| `GENERATE_MEDIA` action | Agent responds to "draw me a ...", "say ...", "speak ...", etc. by calling the local image or TTS backend. |
| `TEXT_SMALL` / `TEXT_LARGE` handler | Agent uses the active Eliza-1 text model for all reasoning and response generation. |
| `TEXT_EMBEDDING` handler | Agent embeds memories using the local embedding GGUF; avoids cloud API calls for RAG. |
| `TEXT_TO_SPEECH` handler | Agent converts text to audio using Kokoro (or another registered TTS backend). |
| `TRANSCRIPTION` handler | Agent transcribes audio using whisper.cpp. |
| `IMAGE` handler | Agent generates images using the active local diffusion backend. |
| `IMAGE_DESCRIPTION` handler | Agent describes images using the active multimodal model. |

## Requirements

- Node.js 20+ or Bun runtime.
- The fused `libelizainference` native library for the desktop text/voice/vision path (built from `tools/omnivoice`; resolved via `ELIZA_INFERENCE_LIBRARY` / `ELIZA_INFERENCE_LIB_DIR` or the bundle's `lib/` dir). Generic single-file GGUF additionally needs the explicit-`modelPath` binding (`llama-cpp-capacitor` on mobile).
- Native binaries for optional capabilities: `sd.cpp` for image-gen on Linux/Windows, `mflux` for Apple Silicon image-gen, `whisper.cpp` built with the shared library flag for ASR.
- An Eliza-1 GGUF bundle downloaded via the model catalog (dashboard → Models, or `POST /api/local-inference/downloads`).

## Enabling the plugin

Add `@elizaos/plugin-local-inference` to the `plugins` array in your elizaOS agent character or bootstrap configuration:

```ts
import localInferencePlugin from "@elizaos/plugin-local-inference";

const agent = new AgentRuntime({
  plugins: [localInferencePlugin],
  // ...
});
```

The plugin registers its model handlers at priority `−100`. The routing-policy layer (not raw priority) controls whether a given request is served locally or by a cloud provider. Users configure this in the dashboard under Settings → Model Routing.

## Configuration

Key environment variables (all optional unless noted):

| Variable | Purpose |
|---|---|
| `MODELS_DIR` | Override the GGUF model directory (default: `~/.eliza/models`) |
| `LOCAL_SMALL_MODEL` | Small model filename (mobile/Capacitor adapter) |
| `LOCAL_LARGE_MODEL` | Large model filename (mobile/Capacitor adapter) |
| `ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP` | Set truthy to defer startup GGUF embedding prefetch until the dev/runtime server is ready |
| `ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP` | Set truthy to skip GGUF embedding prefetch entirely while leaving local embedding settings intact |
| `ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP` | Desktop startup opt-in that starts GGUF embedding warmup during runtime bootstrap when no skip/defer override is set |
| `ELIZA_DISABLE_LOCAL_EMBEDDINGS` | Set `1` to disable local `TEXT_EMBEDDING` registration entirely |
| `ELIZA_IMAGEGEN_ACCELERATOR` | Force image-gen backend: `coreml`, `mflux`, `sd-cpp`, `tensorrt` |
| `ELIZA_DEVICE_BRIDGE_ENABLED` | Enable iOS/AOSP physical device bridge |
| `SD_CPP_BIN` | Absolute path to sd.cpp binary |
| `MFLUX_BIN` | Absolute path to mflux binary |
| `ELIZA_KOKORO_DEFAULT_VOICE_ID` | Default Kokoro TTS voice |
| `ELIZA_WHISPER_USE_GPU` | Enable GPU for Whisper ASR |

## Architecture notes

The plugin exposes these subpath exports (see `package.json` `exports`):

- `@elizaos/plugin-local-inference` — plugin object, `GENERATE_MEDIA` action, `handleLocalInferenceRoutes`, embedding presets.
- `@elizaos/plugin-local-inference/runtime` — boot-time handler registration (`ensureLocalInferenceHandler`), embedding warm-up policy, mobile gate.
- `@elizaos/plugin-local-inference/runtime/embedding-presets` — `detectEmbeddingPreset`, `EMBEDDING_PRESETS`.
- `@elizaos/plugin-local-inference/routes` — HTTP route handlers (`handleLocalInferenceCompatRoutes`, TTS/ASR, voice) mounted by app-core.
- `@elizaos/plugin-local-inference/services` — full service surfaces (engine, arbiter, catalog, recommendation, voice) for deep integrations.

The **MemoryArbiter** (`services/memory-arbiter.ts`) is the single coordination point for all model handles across modalities. On memory-constrained devices (mobile, low-RAM desktop), the arbiter evicts models by priority before loading a new one. Cross-plugin consumers (vision, image-gen) register capabilities via `arbiter.registerCapability(...)` rather than loading models independently.

For agent-facing documentation see `CLAUDE.md` / `AGENTS.md` in this directory.
