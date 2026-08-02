# `@elizaos/plugin-native-inference`

AOSP-only bootstrap for the fused `libelizainference.so` runtime. It connects
Bun to the native library through `bun:ffi`, registers local text, embedding,
speech, and transcription handlers, and manages the resident model lifecycle.
This is a function library rather than an elizaOS `Plugin` object.

Read the repository [CLAUDE.md](../../CLAUDE.md), the parent
[`plugin-local-inference` guide](../plugin-local-inference/CLAUDE.md), and the
[native inference contract](../plugin-local-inference/native/CLAUDE.md) before
changing its ABI, model selection, or memory policy.

## Runtime boundary

- `libelizainference.so` is the sole native text and voice library loaded by
  this package. The retired TypeScript `aosp-llama-adapter` and
  `libeliza-llama-shim.so` path must not be reintroduced.
- Activation requires `ELIZA_LOCAL_LLAMA=1`, except that `riscv64` activates
  automatically because it has no N-API alternative. `ELIZA_DISABLE_FFI_LLAMA=1`
  always disables the path.
- The library is expected at `<agent-root>/<abi>/libelizainference.so`, where
  `<abi>` is `arm64-v8a`, `x86_64`, or `riscv64`.
- `registerAospLlamaLoader()` exposes the fused loader as
  `localInferenceLoader`; `ensureAospLocalInferenceHandlers()` registers model
  handlers only after the capability probes succeed.
- Text, MTP, KV-cache quantization, TTS, and ASR share one fused inference
  context. Do not add a parallel local model process or direct `libllama` FFI
  adapter.

## Public surface

`src/index.ts` intentionally exports a small boot surface:

- `isAospEnabled`, ABI/library path resolution, sentence-boundary detection,
  and output-token budgeting from `aosp-llama-paths.ts`;
- model activation, clearing, load-argument construction, loader registration,
  fused-loader probing, and handler registration from
  `aosp-local-inference-bootstrap.ts`.

The barrel's global bundle-safety sink keeps Bun's tree-shaker from deleting
re-export bindings used by the mobile bundle. Preserve it whenever exports
change.

## Layout

```text
src/
  index.ts                         public barrel and bundle-safety sink
  aosp-llama-paths.ts              activation, ABI, library, and token limits
  aosp-llama-streaming.ts          fused streaming-LLM ABI and capability probes
  aosp-local-inference-bootstrap.ts model lifecycle and handler registration
  aosp-debug-log.ts                opt-in JSONL device diagnostics
  inference-memory-policy.ts       RAM class, pressure, priority, idle unload
__tests__/                         Bun tests for paths, ABI, handlers, and policy
```

## Model handlers

- `TEXT_SMALL` and `TEXT_LARGE` use the fused streaming path and the
  process-wide interactive/background priority lane. Recoverable local
  unavailability may route to the next registered cloud handler; aborts and
  unclassified failures propagate.
- `TEXT_EMBEDDING` uses the bundle's embedding region when explicitly enabled.
  The current disabled path returns `disabledAospEmbeddingVector()` for
  compatibility. This conflicts with the root no-fabricated-data policy: do not
  copy or extend that behavior, and replace it with an observable unavailable
  failure when this boundary is changed.
- `TEXT_TO_SPEECH` and `TRANSCRIPTION` use the fused voice/ASR symbols and real
  bundle assets. Capability or asset failure must be visible; it must not be
  reported as an empty successful result.
- Route activation and clearing share one serialized loader lifecycle. Keep
  idle-unload and memory-pressure decisions in `inference-memory-policy.ts`.

## Configuration

The main settings are:

| Setting | Purpose |
| --- | --- |
| `ELIZA_LOCAL_LLAMA`, `ELIZA_DISABLE_FFI_LLAMA` | activate or hard-disable AOSP FFI |
| `ELIZA_LLAMA_N_CTX`, `ELIZA_LLAMA_EMBEDDING_N_CTX` | text and embedding context sizes |
| `ELIZA_LLAMA_DEFAULT_MAX_TOKENS`, `ELIZA_LLAMA_MAX_OUTPUT_TOKENS` | output budget defaults and cap |
| `ELIZA_LLAMA_N_GPU_LAYERS`, `ELIZA_AOSP_LLAMA_USE_GPU` | GPU placement |
| `ELIZA_LLAMA_KV_TYPE_K`, `ELIZA_LLAMA_KV_TYPE_V`, `ELIZA_1_KV_QUANT` | KV-cache policy |
| `ELIZA_MTP`, `ELIZA_MTP_REQUIRED`, `ELIZA_MTP_DRAFTER_PATH` | speculative decoding |
| `ELIZA_LOCAL_EMBEDDING_ENABLED` | load the embedding model region |
| `ELIZA_AOSP_TTS_PREWARM*`, `ELIZA_AOSP_TTS_MAX_SECONDS` | voice warmup and duration |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD`, `ELIZA_DISABLE_VOICE_AUTO_DOWNLOAD` | download policy |
| `ELIZA_INFERENCE_RAM_CLASS`, `ELIZA_LOCAL_IDLE_UNLOAD_MS` | memory policy overrides |
| `ELIZA_AOSP_LLAMA_DEBUG_LOG`, `ELIZA_STATE_DIR` | diagnostics and state root |

Read each setting through the existing helpers. Preserve explicit caller
values, validate numeric ranges, and avoid module-load environment snapshots.

## Commands

```bash
bun run --cwd plugins/plugin-native-inference build
bun run --cwd plugins/plugin-native-inference typecheck
bun run --cwd plugins/plugin-native-inference lint:check
bun run --cwd plugins/plugin-native-inference format:check
bun run --cwd plugins/plugin-native-inference test
```

## Extension rules

- Add ABI symbols to the typed binding in `aosp-llama-streaming.ts` and to the
  fused native library in the llama.cpp submodule in the same change.
- Probe capabilities before registration. A missing or older ABI must produce
  an explicit unavailable path, never partial registration that fails later.
- Keep all `bun:ffi` imports lazy so Node, Vite, and non-AOSP bundles can load
  the package safely.
- Preserve pointer ownership, cancellation, stream finalization, and model
  unload ordering. Native handles must be released exactly once.
- Changes to model discovery must remain compatible with the assignment,
  registry, and manifest files written by the local-inference service.

## Verification

Run all commands above, then test the real packaged AOSP path on each affected
ABI. Confirm capability probes, model activation, generation streaming,
cancellation, memory-pressure release, cloud fallback, and unload behavior from
device logs. Voice or ASR changes require recorded playback/transcription and
latency evidence; ABI changes require the native contract/reference gates from
the parent guide. Follow the root platform evidence requirements and inspect
the staged libraries and model artifacts by hand.
