# @elizaos/plugin-local-inference

Eliza-1 local inference provider: text generation, embeddings, TTS, ASR, image generation, and vision description — all served through the elizaOS model-handler registry without a network call.

## Purpose / role

This plugin registers model handlers for `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `IMAGE`, `IMAGE_DESCRIPTION`, `TEXT_TO_SPEECH`, and `TRANSCRIPTION`. It also exposes the `GENERATE_MEDIA` agent action and HTTP routes for the model catalog, download orchestration, hardware detection, and voice tooling. The plugin is opt-in: it must be added to the elizaOS agent's plugin list. It requires at minimum one active local backend (an Eliza-1 GGUF bundle loaded via `LocalInferenceService` or an AOSP/device-bridge loader); without one, every model call throws `LocalInferenceUnavailableError` with code `LOCAL_INFERENCE_UNAVAILABLE`.

## Plugin surface

### Actions
| Name | Description |
|---|---|
| `GENERATE_MEDIA` | Classifies user text as image/audio/video intent, then dispatches to `ModelType.IMAGE` or `ModelType.TEXT_TO_SPEECH`. Video is refused cleanly. |

### Model handlers (registered by `createLocalInferenceModelHandlers()`)
`TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `IMAGE`, `IMAGE_DESCRIPTION`, `TEXT_TO_SPEECH`, `TRANSCRIPTION`

`TEXT_EMBEDDING` is **not** registered on the static plugin object — it is wired at boot by `ensureLocalInferenceHandler()` in the runtime subpath to avoid claiming the embedding slot before a backend is active.

### Services (consumed, not registered as elizaOS services)
- `LocalInferenceService` / `localInferenceService` (`src/services/service.ts`) — singleton facade for download orchestration, active-model coordination, hardware probe, catalog, and routing preferences.
- `LocalInferenceEngine` / `localInferenceEngine` (`src/services/engine.ts`) — owns one in-process llama.cpp binding via `node-llama-cpp` FFI; one model loaded at a time (unload-then-load for model swaps).
- `MemoryArbiter` (`src/services/memory-arbiter.ts`) — single arbiter that cross-plugin consumers (vision, image-gen, ASR, TTS) call to acquire a model handle without double-allocating RAM.

### HTTP routes (mounted by app-core)
Import from `@elizaos/plugin-local-inference/routes`:
- Catalog, download, status, and chat-command routes via `handleLocalInferenceRoutes` (`src/local-inference-routes.ts`)
- TTS: `handleLocalInferenceTtsRoute` (`src/routes/local-inference-tts-route.ts`)
- ASR: `handleLocalInferenceAsrRoute` (`src/routes/local-inference-asr-route.ts`)
- Voice first-run: `handleVoiceFirstRunRoutes` (`src/routes/voice-first-run-routes.ts`)
- Voice models: `handleVoiceModelsRoutes` (`src/routes/voice-models-routes.ts`)
- Voice profiles: `handleVoiceProfileRoutes` (`src/services/voice/voice-profile-routes.ts`)
- Family-member voice encoder: `handleFamilyMemberRoute` (`src/routes/family-member-route.ts`)
- OpenAI-compat routes: `src/routes/local-inference-compat-routes.ts`

### Runtime boot exports
Import from `@elizaos/plugin-local-inference/runtime`:
- `ensureLocalInferenceHandler` — registers `TEXT_SMALL`/`TEXT_LARGE`/`TEXT_EMBEDDING` handlers and wires the routing-policy layer at boot.
- `shouldWarmupLocalEmbeddingModel` — policy gate for embedding warm-up.
- `shouldEnableMobileLocalInference` — gate for Capacitor/mobile paths.
- `detectEmbeddingPreset`, `EMBEDDING_PRESETS`, `EmbeddingPreset`, `EmbeddingTier` — embedding-model preset detection.

## Layout

```
src/
  index.ts                        Public re-exports (plugin object, actions, route helpers, embedding presets)
  provider.ts                     Plugin object definition; model-handler factory; LocalInferenceUnavailableError
  local-inference-routes.ts       HTTP handler for catalog/download/status/chat-command routes

  actions/
    generate-media.ts             GENERATE_MEDIA action: keyword+classifier intent routing → IMAGE or TTS

  routes/
    index.ts                      Re-exports all route handlers
    local-inference-tts-route.ts  POST /local-inference/tts
    local-inference-asr-route.ts  POST /local-inference/asr
    local-inference-compat-routes.ts  OpenAI-compat /v1/chat/completions etc.
    voice-first-run-routes.ts     Voice onboarding flow
    voice-models-routes.ts        Voice model install/update routes
    family-member-route.ts        Family-member voice encoder route

  runtime/
    index.ts                      Boot-time exports (ensureLocalInferenceHandler, embedding policy, mobile gate)
    ensure-local-inference-handler.ts  Registers text/embedding handlers; wires router-handler
    embedding-presets.ts          detectEmbeddingPreset(), EMBEDDING_PRESETS
    embedding-warmup-policy.ts    shouldWarmupLocalEmbeddingModel()
    embedding-manager-support.ts  GGUF file probe helpers, DEFAULT_MODELS_DIR
    mobile-local-inference-gate.ts  shouldEnableMobileLocalInference()

  services/
    index.ts                      Re-exports all service surfaces
    service.ts                    LocalInferenceService singleton (download, active-model, catalog, routing)
    engine.ts                     LocalInferenceEngine — llama.cpp FFI, one model at a time
    memory-arbiter.ts             MemoryArbiter — cross-plugin model handle arbiter (WS1)
    active-model.ts               ActiveModelCoordinator, load-args resolution, manifest validation
    backend.ts                    BackendDispatcher — selects llama-cpp backend per catalog entry
    catalog.ts                    Re-exports from @elizaos/shared (Eliza-1 tier ids, MODEL_CATALOG)
    types.ts                      Re-exports from @elizaos/shared (CatalogModel, InstalledModel, …)
    hardware.ts                   probeHardware(), assessFit()
    recommendation.ts             selectRecommendedModels(), recommendForFirstRun()
    downloader.ts                 Downloader — HuggingFace GGUF download with resume + progress events
    device-tier.ts                classifyDeviceTier(), DeviceTier thresholds
    router-handler.ts             installRouterHandler() — routing-policy layer (manual/cloud/local)
    memory-arbiter.ts             MemoryArbiter + capability registration API
    cloud-fallback.ts             makeCloudFallbackHandler() — local → cloud fallback on error
    paths.ts                      localInferenceRoot(), elizaModelsDir(), registryPath()
    registry.ts                   listInstalledModels(), upsertElizaModel(), removeElizaModel()
    hf-search.ts                  searchHuggingFaceGguf(), searchModelHubGguf()
    imagegen/                     Image generation backends (sd.cpp, CoreML, mflux, AOSP, TensorRT)
    tts/                          TTS pipeline helpers and audio cache
    asr/                          ASR backend interface and capability registration
    vision/                       Vision-describe backend interface and capability registration
    voice/                        Full voice pipeline: Kokoro TTS, Whisper ASR, VAD, barge-in, speaker imprint, profiles
```

## Commands

```bash
bun run --cwd plugins/plugin-local-inference build        # compile with build.ts
bun run --cwd plugins/plugin-local-inference test         # vitest run (NODE_OPTIONS=--experimental-sqlite)
bun run --cwd plugins/plugin-local-inference typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-local-inference lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-local-inference lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-local-inference format       # biome format --write
bun run --cwd plugins/plugin-local-inference format:check # biome format (read-only)
bun run --cwd plugins/plugin-local-inference probe:sd-cpp # probe sd.cpp binary
bun run --cwd plugins/plugin-local-inference clean        # rm dist .turbo node_modules
```

## Config / env vars

| Variable | Required | Purpose |
|---|---|---|
| `MODELS_DIR` | No | Override default GGUF model directory (default: `~/.eliza/models`) |
| `LOCAL_SMALL_MODEL` | No | Filename of the small text model GGUF (Capacitor/mobile adapter) |
| `LOCAL_LARGE_MODEL` | No | Filename of the large text model GGUF (Capacitor/mobile adapter) |
| `ELIZA_DISABLE_LOCAL_EMBEDDINGS` | No | Set `1` to skip local embedding warm-up |
| `ELIZA_LOCAL_LLAMA` | No | Set `1` to force AOSP local inference path |
| `ELIZA_INFERENCE_BACKEND` | No | Override backend selection (`llama-cpp`) |
| `ELIZA_INFERENCE_LIB_DIR` | No | Directory for native llama.cpp shared library |
| `ELIZA_INFERENCE_LIBRARY` | No | Path to specific native library file |
| `ELIZA_IMAGEGEN_ACCELERATOR` | No | Accelerator for image-gen backend (`coreml`, `tensorrt`, `mflux`, `sd-cpp`) |
| `ELIZA_DEVICE_BRIDGE_ENABLED` | No | Enable iOS/AOSP device-bridge mode |
| `ELIZA_DEVICE_PAIRING_TOKEN` | No | Pairing token for device bridge |
| `ELIZA_KOKORO_DEFAULT_VOICE_ID` | No | Default Kokoro TTS voice id |
| `HF_TOKEN` / `HUGGINGFACE_TOKEN` / `HF_HUB_TOKEN` | No | HuggingFace token for gated model downloads |
| `SD_CPP_BIN` | No | Absolute path to sd.cpp binary |
| `MFLUX_BIN` | No | Absolute path to mflux binary |
| `IMAGEGEN_TRT_BIN` | No | Absolute path to TensorRT image-gen binary |
| `LOCAL_INFERENCE_IMAGE_MODEL_KEY` | No | Pin a specific image-gen model key |
| `LOCAL_INFERENCE_ACTIVE_TIER` | No | Pin a specific Eliza-1 tier (e.g. `eliza-1-4b`) |
| `ELIZA_WHISPER_USE_GPU` | No | Enable GPU acceleration for Whisper ASR |
| `LOCAL_EMBEDDING_MODEL` | No | Override embedding model filename |
| `LOCAL_EMBEDDING_GPU_LAYERS` | No | GPU layers for embedding model |
| `LOCAL_EMBEDDING_CONTEXT_SIZE` | No | Context size for embedding model |
| `LOCAL_EMBEDDING_DIMENSIONS` | No | Embedding dimension override |

Paths are resolved relative to `resolveStateDir()` from `@elizaos/core` (defaults to `~/.eliza`). Set `ELIZA_STATE_DIR` to relocate.

## How to extend

### Add a new action
1. Create `src/actions/my-action.ts` implementing `Action` from `@elizaos/core`.
2. Export it from `src/index.ts`.
3. Add it to the `actions` array in `localInferencePlugin` in `src/provider.ts`.

### Add a new route handler
1. Create `src/routes/my-route.ts` exporting a handler function.
2. Export it from `src/routes/index.ts`.
3. Mount it in the consuming runtime (app-core `src/api/server.ts`) by importing from `@elizaos/plugin-local-inference/routes`.

### Add a new backend capability (e.g. a new image-gen backend)
1. Implement the capability in `src/services/imagegen/` following the `ImageGenBackend` interface.
2. Export it from `src/services/imagegen/index.ts`.
3. Register it via `createImageGenCapabilityRegistration(...)` inside `LocalInferenceService.init()` in `service.ts`.
4. The `MemoryArbiter` will then dispatch `arbiter.requestImageGen(...)` calls to your backend.

### Register a new arbiter capability (cross-plugin)
Call `arbiter.registerCapability({ capability, residentRole, load, unload, run })` from the plugin that owns the model binding. The arbiter handles eviction, queuing, and memory pressure signals. Import `getMemoryArbiter` / `setMemoryArbiter` from `@elizaos/plugin-local-inference/services`.

## Conventions / gotchas

- **`node-llama-cpp` is an optional dependency.** The engine checks `available()` before using it; missing the package produces a clean `LocalInferenceUnavailableError` rather than a crash.
- **`TEXT_EMBEDDING` is NOT in the static plugin `models` map.** It is wired by `ensureLocalInferenceHandler()` at boot to avoid claiming the embedding slot before an Eliza-1 bundle is active. Do not add it to the static plugin object.
- **Native binary deps** (sd.cpp, mflux, whisper.cpp, Kokoro ONNX) must be present on the host or downloaded separately. The plugin does not bundle them; `probe:sd-cpp` checks for sd.cpp.
- **MemoryArbiter (WS1)** is the coordination point for all modalities on memory-constrained devices. Cross-plugin consumers (vision, image-gen, ASR, TTS) must go through the arbiter — never load models independently.
- **Catalog source of truth** lives in `@elizaos/shared` (`MODEL_CATALOG`, tier ids, HuggingFace URL builders). `src/services/catalog.ts` is a thin re-export shim.
- **Type source of truth** for `CatalogModel`, `InstalledModel`, `AgentModelSlot`, etc. also lives in `@elizaos/shared`. `src/services/types.ts` re-exports them.
- **Plugin priority is `−100`.** This is below cloud providers so the routing-policy layer (not raw priority) decides which provider fires per request.
- The `GENERATE_MEDIA` action uses keyword matching first, then falls back to a `TEXT_SMALL` JSON classifier call. It does not perform intent detection on every message — the `validate` function only checks for non-empty text.
- Voice pipeline (`services/voice/`) is large and self-contained. Entry points: `src/services/voice/index.ts`, `src/routes/voice-first-run-routes.ts`, `src/routes/voice-models-routes.ts`.
- See `AGENTS.md` at the repo root for architecture rules, git workflow, and global coding standards.
