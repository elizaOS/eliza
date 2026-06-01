# @elizaos/plugin-aosp-local-inference

AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and local-inference bootstrap for elizaOS mobile builds.

## Purpose / role

This package wires `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `TEXT_TO_SPEECH`, and `TRANSCRIPTION` model handlers for Eliza agents running on Android (AOSP). It is not an elizaOS `Plugin` object — it exports two call-time bootstrap functions consumed by `@elizaos/agent`'s mobile entrypoint and by `@elizaos/app-core`'s `ensure-local-inference-handler.ts`. Both modules self-gate on `ELIZA_LOCAL_LLAMA=1` (or `process.arch === "riscv64"`) and are no-ops on every other platform, so they can be imported unconditionally from the mobile agent barrel without breaking non-AOSP builds.

## Plugin surface

This package does **not** export a `Plugin` object. It exports named functions only:

| Export | File | Purpose |
|---|---|---|
| `registerAospLlamaLoader` | `aosp-llama-adapter.ts` | dlopen `libllama.so` + `libeliza-llama-shim.so` via `bun:ffi`; register the native loader as `localInferenceLoader` service |
| `ensureAospLocalInferenceHandlers` | `aosp-local-inference-bootstrap.ts` | Register `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `TEXT_TO_SPEECH`, `TRANSCRIPTION` on `AgentRuntime`; pre-warm chat model and TTS backend |
| `activateAospLocalInferenceModel` | `aosp-local-inference-bootstrap.ts` | Hot-swap a loaded model (called by the route-activation API) |
| `clearAospLocalInferenceModel` | `aosp-local-inference-bootstrap.ts` | Unload the current model and clear state |
| `buildAospLoadModelArgs` | `aosp-local-inference-bootstrap.ts` | Build `AospLoadModelArgs` from env + role (`"chat"` or `"embedding"`) |
| `isAospEnabled` | `aosp-llama-adapter.ts` | Returns true when `ELIZA_LOCAL_LLAMA=1` or `process.arch === "riscv64"` and not opted out |
| `resolveLibllamaPath` / `resolveLlamaShimPath` | `aosp-llama-adapter.ts` | Resolve per-ABI `.so` paths under `cwd/{abi}/` |
| `resolveThreads` | `aosp-llama-adapter.ts` | Resolve `n_threads` (explicit → env `ELIZA_LLAMA_THREADS` → `os.cpus()` → 4) |
| `kvCacheTypeNameToEnum` / `readEnvKvCacheType` / `resolveKvCacheType` | `aosp-llama-adapter.ts` | Map KV-cache type names to ggml_type enum values |

## Layout

```
plugins/plugin-aosp-local-inference/
  src/
    index.ts                        Barrel — re-exports everything; bundle-safety sink prevents tree-shake collapse
    aosp-llama-adapter.ts           bun:ffi loader: dlopen libllama.so + shim, AospLlamaAdapter class, loader registration
    aosp-llama-streaming.ts         Streaming-LLM FFI bindings for libelizainference.so streaming symbols
    aosp-local-inference-bootstrap.ts  Model-handler registrar: TEXT_* handlers, OmniVoice/fused-TTS, ASR, cloud-fallback, pre-warm
    aosp-debug-log.ts               Append-only NDJSON debug log to $ELIZA_STATE_DIR/aosp-llama-debug.log (gated by ELIZA_AOSP_LLAMA_DEBUG_LOG)
  __tests__/
    aosp-abi-riscv64.test.ts        ABI path resolution tests for riscv64
    aosp-kokoro-tts-handler.test.ts TTS handler unit tests
    aosp-llama-streaming.test.ts    Streaming binding tests
    aosp-local-inference-bootstrap.test.ts  Bootstrap function unit tests
  package.json
  tsconfig.json
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-aosp-local-inference build       # tsc --noCheck --noEmit (no type-checking, no output; parse validation only)
bun run --cwd plugins/plugin-aosp-local-inference typecheck   # tsgo full typecheck
bun run --cwd plugins/plugin-aosp-local-inference clean       # remove dist, .turbo, node_modules
bun run --cwd plugins/plugin-aosp-local-inference test        # bun test __tests__
```

## Config / env vars

All env vars are read at call time (no module-load side effects).

| Env var | Required | Purpose |
|---|---|---|
| `ELIZA_LOCAL_LLAMA` | Yes (on AOSP) | Set to `"1"` to activate the FFI loader. Set by `ElizaAgentService.java` before launching the bun process. |
| `ELIZA_DISABLE_FFI_LLAMA` | No | Set to `"1"` to force opt-out even on riscv64 or when `ELIZA_LOCAL_LLAMA=1`. |
| `ELIZA_LLAMA_THREADS` | No | CPU thread count override. Set by Java to `Runtime.availableProcessors()`. Falls back to `os.cpus().length` or 4. |
| `ELIZA_LLAMA_N_CTX` | No | Context window size for chat model (default 4096). |
| `ELIZA_LLAMA_EMBEDDING_N_CTX` | No | Context window size for embedding model (default 512). |
| `ELIZA_LLAMA_N_GPU_LAYERS` | No | Explicit GPU layer count. Overrides `ELIZA_AOSP_LLAMA_USE_GPU`. |
| `ELIZA_AOSP_LLAMA_USE_GPU` | No | Boolean flag — if `"true"`, uses 99 GPU layers; default 0 (CPU only). |
| `ELIZA_LLAMA_CACHE_TYPE_K` / `ELIZA_LLAMA_CACHE_TYPE_V` | No | KV-cache type: `f16`, `tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar`. Chat defaults: K=`qjl1_256`, V=`q4_polar`. |
| `ELIZA_LLAMA_DEFAULT_MAX_TOKENS` | No | Default max output tokens (default 512). |
| `ELIZA_LLAMA_MAX_OUTPUT_TOKENS` | No | Hard cap on output tokens (default 256; capped against context). |
| `ELIZA_LOCAL_EMBEDDING_ENABLED` | No | Set to `"1"` to load the embedding GGUF. Default: disabled (zero-vector returned). |
| `ELIZA_LOCAL_EMBEDDING_DIMENSIONS` | No | Zero-vector dimension when embeddings are disabled (default 384). |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` | No | Set to `"1"` to disable auto-download of recommended models from HuggingFace. |
| `ELIZA_MTP` | No | Boolean — enable in-process MTP speculative decoding. |
| `ELIZA_MTP_REQUIRED` | No | Boolean — require MTP; fail if unavailable. |
| `ELIZA_MTP_DRAFTER_PATH` | No | Explicit path to the MTP drafter GGUF. |
| `ELIZA_MTP_DRAFT_N_CTX` | No | Draft context size (default: `min(2048, targetCtx)`). |
| `ELIZA_MTP_DRAFT_N_BATCH` / `ELIZA_MTP_DRAFT_N_UBATCH` | No | Batch sizes for the draft model. |
| `ELIZA_MTP_DRAFT_MIN` / `ELIZA_MTP_DRAFT_MAX` | No | Min/max draft tokens (defaults 1/16). |
| `ELIZA_MTP_DRAFT_P_MIN` | No | Minimum token probability for MTP draft acceptance (default 0.25). |
| `OMNIVOICE_LIB_PATH` | No | Override path to `libomnivoice.so`. Auto-resolved from ABI dir. |
| `OMNIVOICE_MODEL_PATH` / `OMNIVOICE_CODEC_PATH` | No | Override TTS model/codec GGUF paths. Auto-resolved from active bundle's `tts/` dir. |
| `ELIZA_AOSP_TTS_BACKEND` / `ELIZA_LOCAL_TTS_BACKEND` | No | TTS backend selector. Currently only `"omnivoice"` (fused `libelizainference.so`) is active. |
| `ELIZA_AOSP_TTS_PREWARM` | No | Set to `"true"` to pre-warm TTS on a timer after boot. |
| `ELIZA_AOSP_TTS_PREWARM_DELAY_MS` / `ELIZA_AOSP_TTS_PREWARM_TIMEOUT_MS` | No | Pre-warm delay (default 5000 ms) and timeout (default 45000 ms). |
| `ELIZA_AOSP_OMNIVOICE_MASKGIT_STEPS` / `ELIZA_TTS_MASKGIT_STEPS` | No | Override MaskGit decode steps (1–64). |
| `ELIZA_AOSP_TTS_MAX_SECONDS` | No | Maximum synthesized audio duration (default 30 s). |
| `ELIZA_AOSP_LLAMA_DEBUG_LOG` | No | Path to append NDJSON debug events. Set to `"1"` to use `$ELIZA_STATE_DIR/aosp-llama-debug.log`. |
| `ELIZA_STATE_DIR` | No | State root for model storage. Resolved by `@elizaos/core`'s `resolveStateDir()`. |

## How to extend

**Add a new model handler type:**
1. Add the handler factory function in `src/aosp-local-inference-bootstrap.ts` following the pattern of `makeGenerateHandler` or `makeEmbeddingHandler`.
2. Add the new `ModelType` slot to the `slots` array in `ensureAospLocalInferenceHandlers`.
3. Register it with `runtimeWithRegistration.registerModel(modelType, handler, PROVIDER, LOCAL_INFERENCE_PRIORITY)`.

**Add a new KV-cache type:**
1. Add the `GGML_TYPE_*` constant and the new entry to `KvCacheTypeName` union in `src/aosp-llama-adapter.ts`.
2. Add the case to `kvCacheTypeNameToEnum` and `readEnvKvCacheType`.
3. Add the corresponding `eliza_llama_context_params_set_type_k/v` shim binding in `dlopenShim` if not already present.

**Add a new native symbol to the shim:**
1. Add the typed signature to `ShimSymbols` or `LlamaSymbols` in `src/aosp-llama-adapter.ts`.
2. Add the FFIType descriptor to `dlopenShim` / `dlopenLlama`.
3. Update `eliza_llama_shim.c` in `scripts/elizaos/llama-shim/` and rebuild `libeliza-llama-shim.so`.

## Conventions / gotchas

- **bun:ffi only.** This module targets Bun at runtime. `bun:ffi` is imported lazily via `import(specifier)` to avoid breaking Vite/Vitest/Node bundlers. Tests run under `bun test`; any non-Bun test runner will not be able to exercise the FFI paths.
- **Bundle-safety sink.** `src/index.ts` contains a `const __bundle_safety_*` array that references every re-exported binding. This prevents Bun.build's tree-shaker from collapsing the barrel into an empty init function, which causes `ReferenceError` at runtime on device. Do not remove this pattern.
- **No Plugin object.** This package does not export or register an elizaOS `Plugin`. Both exported bootstrap functions are called explicitly by the agent entrypoint or app-core; they are not auto-discovered by the plugin loader.
- **Struct-by-value workaround.** `bun:ffi` cannot pass llama.cpp structs by value. `libeliza-llama-shim.so` wraps every struct-by-value entry point with a pointer-style equivalent. The shim's `*_params_default()` functions return `malloc`'d pointers; callers must free them with the matching `*_params_free()`. The adapter always does this in `try/finally`.
- **ABI dirs.** Native `.so` files are expected at `cwd/{abi}/libllama.so` etc., where `{abi}` is `arm64-v8a`, `x86_64`, or `riscv64`. `ElizaAgentService.java` sets `LD_LIBRARY_PATH` to this dir before spawning bun.
- **libllama.so fork.** The bundled `libllama.so` is built from the `apothic/llama.cpp-1bit-turboquant` fork (tag `main-b8198-b2b5273`) extended with `elizaOS/llama.cpp @ v0.1.0-eliza`. It adds KV-cache quant types TBQ3_0=43, TBQ4_0=44, QJL1_256=46, Q4_POLAR=47. Stock llama.cpp `.so` files will not expose these types.
- **Model discovery.** At boot, `ensureAospLocalInferenceHandlers` resolves bundled model paths from (in priority order): `local-inference/assignments.json` → `local-inference/registry.json`, then `local-inference/models/manifest.json`, then a glob fallback scan of `$ELIZA_STATE_DIR/local-inference/models/`. If no model is found and `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` is not set, it auto-downloads from `elizaos/eliza-1` on HuggingFace.
- **Cloud fallback.** For `TEXT_SMALL` and `TEXT_LARGE`, a secondary handler is registered at priority `-1` as `eliza-aosp-llama-cloud-fallback`. When the local FFI handler fails with a classified recoverable error (`local-unavailable`, `local-overloaded`, `local-error`), this wrapper locates the next-highest registered handler (a cloud provider) and forwards the request. `AbortError` and unclassified errors propagate directly.
- **Root AGENTS.md** covers all global conventions (logger-only, ESM, architecture rules, naming). This file covers only what is specific to this package.
