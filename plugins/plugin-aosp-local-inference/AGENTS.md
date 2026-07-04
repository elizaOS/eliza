# @elizaos/plugin-aosp-local-inference

AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and local-inference bootstrap for elizaOS mobile builds.

## Purpose / role

This package wires `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, `TEXT_TO_SPEECH`, and `TRANSCRIPTION` model handlers for Eliza agents running on Android (AOSP). It is not an elizaOS `Plugin` object — it exports two call-time bootstrap functions consumed by `@elizaos/agent`'s mobile entrypoint and by `@elizaos/plugin-local-inference`'s `ensure-local-inference-handler.ts`. Both modules self-gate on `ELIZA_LOCAL_LLAMA=1` (or `process.arch === "riscv64"`) and return without registration on every other platform, so they can be imported unconditionally from the mobile agent barrel without breaking non-AOSP builds.

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
    aosp-llama-streaming.ts         Streaming-LLM FFI binding over a libelizainference.so handle (createAospStreamingLlmBinding, streamGenerate, fusedAospTextSupported gate, config marshaller)
    aosp-local-inference-bootstrap.ts  Model-handler registrar: fused-libelizainference TEXT loader (tryBuildAospFusedTextLoader), TEXT_* handlers, OmniVoice/fused-TTS, ASR, cloud-fallback, pre-warm
    aosp-debug-log.ts               Append-only line-delimited debug log to $ELIZA_STATE_DIR/aosp-llama-debug.log (gated by ELIZA_AOSP_LLAMA_DEBUG_LOG)
  __tests__/
    aosp-abi-riscv64.test.ts        ABI path resolution tests for riscv64
    aosp-fused-text-binding.test.ts Fused text binding + ABI-v9 gate (fusedAospTextSupported) + config-struct marshalling tests
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
| `ELIZA_LLAMA_KV_TYPE_K` / `ELIZA_LLAMA_KV_TYPE_V` | No | KV-cache type: `f16`, `q8_0`, `tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar`. Chat defaults: K=`q8_0`, V=`f16`. |
| `ELIZA_LLAMA_DEFAULT_MAX_TOKENS` | No | Default max output tokens (default 512). |
| `ELIZA_LLAMA_MAX_OUTPUT_TOKENS` | No | Hard cap on output tokens (default 256; capped against context). |
| `ELIZA_LOCAL_EMBEDDING_ENABLED` | No | Set to `"1"` to load the embedding GGUF. Default: disabled (zero-vector returned). |
| `ELIZA_LOCAL_EMBEDDING_DIMENSIONS` | No | Zero-vector dimension when embeddings are disabled (default 384). |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` | No | Set to `"1"` to disable auto-download of recommended models from HuggingFace. |
| `ELIZA_MTP` | No | Boolean — enable in-process MTP speculative decoding. |
| `ELIZA_MTP_REQUIRED` | No | Boolean — require MTP; fail if unavailable. |
| `ELIZA_MTP_DRAFTER_PATH` | No | Explicit path to the MTP drafter GGUF. |
| `ELIZA_MTP_DRAFT_N_CTX` | No | Draft context size (default: 2048). |
| `ELIZA_MTP_DRAFT_N_BATCH` / `ELIZA_MTP_DRAFT_N_UBATCH` | No | Batch sizes for the draft model. |
| `ELIZA_MTP_DRAFT_MIN` / `ELIZA_MTP_DRAFT_MAX` | No | Min/max draft tokens (defaults 1/16). |
| `ELIZA_MTP_DRAFT_P_MIN` | No | Minimum token probability for MTP draft acceptance (default 0.25). |
| `ELIZA_SPEC_TYPE` / `ELIZA_SPECULATIVE_TYPE` | No | Speculative-decoding type selector (e.g. `"draft-mtp"`). `ELIZA_SPEC_TYPE` is checked first; `ELIZA_SPECULATIVE_TYPE` is the legacy alias. |
| `ELIZA_AOSP_TTS_PREWARM` | No | Set to `"true"` to pre-warm TTS on a timer after boot. |
| `ELIZA_AOSP_TTS_PREWARM_DELAY_MS` / `ELIZA_AOSP_TTS_PREWARM_TIMEOUT_MS` | No | Pre-warm delay (default 5000 ms) and timeout (default 45000 ms). |
| `ELIZA_AOSP_TTS_PREWARM_TEXT` | No | Custom utterance used during TTS pre-warm (default `"Hello from Eliza."`). |
| `ELIZA_AOSP_OMNIVOICE_MASKGIT_STEPS` / `ELIZA_TTS_MASKGIT_STEPS` | No | Override MaskGit decode steps (1–64). |
| `ELIZA_AOSP_TTS_MAX_SECONDS` | No | Maximum synthesized audio duration (default 30 s). |
| `ELIZA_AOSP_LLAMA_DEBUG_LOG` | No | Path to append line-delimited debug events. Set to `"1"` to use `$ELIZA_STATE_DIR/aosp-llama-debug.log`. |
| `ELIZA_AOSP_LLAMA_DEBUG_OUTPUT_TAIL` | No | Set to `"0"` to suppress tail-of-output debug logging even when the debug log is active. |
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
3. Update `eliza_llama_shim.c` in `packages/app-core/scripts/aosp/llama-shim/` and rebuild `libeliza-llama-shim.so`.

## Conventions / gotchas

- **bun:ffi only.** This module targets Bun at runtime. `bun:ffi` is imported lazily via `import(specifier)` to avoid breaking Vite/Vitest/Node bundlers. Tests run under `bun test`; any non-Bun test runner will not be able to exercise the FFI paths.
- **Bundle-safety sink.** `src/index.ts` contains a `const __bundle_safety_*` array that references every re-exported binding. This prevents Bun.build's tree-shaker from collapsing the barrel into an empty init function, which causes `ReferenceError` at runtime on device. Do not remove this pattern.
- **No Plugin object.** This package does not export or register an elizaOS `Plugin`. Both exported bootstrap functions are called explicitly by the agent entrypoint or `@elizaos/plugin-local-inference`'s `ensure-local-inference-handler.ts`; they are not auto-discovered by the plugin loader.
- **Struct-by-value workaround.** `bun:ffi` cannot pass llama.cpp structs by value. `libeliza-llama-shim.so` wraps every struct-by-value entry point with a pointer-style equivalent. The shim's `*_params_default()` functions return `malloc`'d pointers; callers must free them with the matching `*_params_free()`. The adapter always does this in `try/finally`.
- **ABI dirs.** Native `.so` files are expected at `cwd/{abi}/libllama.so` etc., where `{abi}` is `arm64-v8a`, `x86_64`, or `riscv64`. `ElizaAgentService.java` sets `LD_LIBRARY_PATH` to this dir before spawning bun.
- **libllama.so fork.** The bundled `libllama.so` is built from the `apothic/llama.cpp-1bit-turboquant` fork (tag `main-b8198-b2b5273`) extended with `elizaOS/llama.cpp @ v0.1.0-eliza`. It adds KV-cache quant types TBQ3_0=43, TBQ4_0=44, QJL1_256=46, Q4_POLAR=47. Stock llama.cpp `.so` files will not expose these types.
- **Fused-vs-libllama text gate.** At boot `tryBuildAospFusedTextLoader()` dlopens `libelizainference.so` (the SAME lib the bun agent already uses for fused TTS/ASR) and probes the ABI-v9 capabilities. Text routes through the fused streaming-LLM path (`eliza_inference_llm_stream_*`, one shared `EliInferenceContext` per bundle, native MTP + KV-quant) ONLY when all three probes pass (`fusedAospTextSupported` = `llmStreamSupported && llmMtpSupported && llmKvQuantSupported`). On a missing / pre-v9 lib the loader returns null and the separate libllama `AospLlamaAdapter` stays the text backend. The selected backend is logged at registration (`text backend fused-libelizainference|libllama`). Chat + embedding loads share one fused context (the C side resolves region per call), so the loader never destroys + recreates the context on a role swap.
- **Model discovery.** At boot, `ensureAospLocalInferenceHandlers` resolves bundled model paths from (in priority order): `local-inference/assignments.json` → `local-inference/registry.json`, then `local-inference/models/manifest.json`, then a glob fallback scan of `$ELIZA_STATE_DIR/local-inference/models/`. If no model is found and `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` is not set, it auto-downloads from `elizaos/eliza-1` on HuggingFace.
- **Cloud fallback.** For `TEXT_SMALL` and `TEXT_LARGE`, a secondary handler is registered at priority `-1` as `eliza-aosp-llama-cloud-fallback`. When the local FFI handler fails with a classified recoverable error (`local-unavailable`, `local-overloaded`, `local-error`), this wrapper locates the next-highest registered handler (a cloud provider) and forwards the request. `AbortError` and unclassified errors propagate directly.
- **Interactive-over-background text lane (#11914).** Every text generate routes through `generateOnPriorityLane` → the process-wide `InferencePriorityGate` (`@elizaos/core`): interactive turns (the default) dispatch ahead of queued background jobs; requests marked `priority: "background"` (scheduled prompt tasks, prompt-batcher drains) run only when the lane is idle, wait at most the RAM-class bound (constrained 120 s / standard 300 s), and are clamped to the RAM-class budget (constrained maxTokens 192 / prompt ≤ 4 000 chars; standard 1 024 / 24 000) before the decode. A bounded-wait timeout throws the typed `InferenceBackgroundWaitTimeoutError` (classified `local-overloaded` → cloud-fallback eligible) without ever reaching the native lane, so a self-queueing background job can't pile abandoned work onto the resident lock. RAM class comes from the #11760 probe (`classifyInferenceRamClass` in `inference-memory-policy.ts`).
- **Root AGENTS.md** covers all global conventions (logger-only, ESM, architecture rules, naming). This file covers only what is specific to this package.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
