# @elizaos/plugin-aosp-local-inference

AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and local-inference bootstrap for elizaOS mobile builds.

## What it does

This package enables on-device inference for Eliza agents running on Android (AOSP). It connects the Bun runtime to a native `libllama.so` + shim via `bun:ffi`, and registers the following model type handlers on `AgentRuntime`:

| Model type | Backend |
|---|---|
| `TEXT_SMALL` / `TEXT_LARGE` | llama.cpp FFI (`libllama.so` via `libeliza-llama-shim.so`) |
| `TEXT_EMBEDDING` | llama.cpp FFI (separate embedding context, disabled by default) |
| `TEXT_TO_SPEECH` | Fused OmniVoice (`libelizainference.so`) — WAV output at 24 kHz |
| `TRANSCRIPTION` | ASR via `libelizainference.so` |

All handlers self-gate on `ELIZA_LOCAL_LLAMA=1` and are no-ops on non-AOSP platforms. The package is safe to import unconditionally from the mobile agent bundle.

## Capabilities

- **Local LLM inference** — in-process llama.cpp via `bun:ffi`; no HTTP server subprocess.
- **Speculative decoding (MTP)** — optional in-process MTP drafter via `libeliza-llama-speculative-shim.so`; auto-paired when a `mtp/` drafter GGUF is found in the active model bundle.
- **Custom KV-cache quantization** — supports `tbq3_0`, `tbq4_0`, `qjl1_256`, `q4_polar` quant types from the elizaOS/llama.cpp fork (default: K=`qjl1_256`, V=`q4_polar` for chat).
- **Text-to-speech** — OmniVoice synthesis via `libelizainference.so`; pre-warm support to amortize first-request latency.
- **Transcription** — ASR via `libelizainference.so` from PCM WAV input or `{ pcm, sampleRateHz }` params.
- **Model auto-download** — if no bundled GGUF is found, downloads `elizaos/eliza-1` from HuggingFace (opt-out: `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1`).
- **Cloud fallback** — for `TEXT_SMALL` / `TEXT_LARGE`, a secondary handler at priority -1 forwards to Eliza Cloud when the local FFI path fails with a recoverable error.

## How to enable

This package is loaded by `@elizaos/agent`'s mobile entrypoint and by `@elizaos/app-core`'s `ensure-local-inference-handler.ts`. It is not an elizaOS plugin with auto-discovery — activation requires calling `ensureAospLocalInferenceHandlers(runtime)` after the agent runtime starts.

Set the following environment variable before launching the bun process (done automatically by `ElizaAgentService.java` in AOSP builds):

```
ELIZA_LOCAL_LLAMA=1
```

The package also auto-activates on `process.arch === "riscv64"` without requiring the env var (unless `ELIZA_DISABLE_FFI_LLAMA=1` is set).

## Required native libraries

The following shared libraries must be present in `cwd/{abi}/` (where `{abi}` is `arm64-v8a`, `x86_64`, or `riscv64`). They are compiled by `scripts/elizaos/compile-libllama.mjs`:

- `libllama.so` — elizaOS/llama.cpp fork (`v0.1.0-eliza`, based on `apothic/llama.cpp-1bit-turboquant` @ `main-b8198-b2b5273`)
- `libeliza-llama-shim.so` — struct-by-value wrapper (NEEDED-links `libllama.so`)
- `libeliza-llama-speculative-shim.so` — MTP speculative decoding (optional)
- `libelizainference.so` — fused OmniVoice TTS + ASR (optional, required for voice)

`ElizaAgentService.java` sets `LD_LIBRARY_PATH` to the ABI dir before spawning bun.

## Required model files

Models are resolved from `$ELIZA_STATE_DIR/local-inference/models/` in priority order:

1. `assignments.json` + `registry.json` (managed by the local-inference service)
2. `manifest.json` (written by `scripts/elizaos/stage-default-models.mjs`)
3. Glob fallback scan for `*.gguf` matching expected name patterns

Default models auto-downloaded from `elizaos/eliza-1` on HuggingFace when not staged:
- **Chat:** `bundles/2b/text/eliza-1-2b-128k.gguf`
- **Embedding:** `bundles/4b/embedding/eliza-1-embedding.gguf`

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ELIZA_LOCAL_LLAMA` | — | Set `"1"` to activate |
| `ELIZA_DISABLE_FFI_LLAMA` | — | Set `"1"` to force opt-out |
| `ELIZA_LLAMA_THREADS` | `os.cpus().length` | CPU thread count |
| `ELIZA_LLAMA_N_CTX` | `4096` | Chat context window |
| `ELIZA_LOCAL_EMBEDDING_ENABLED` | `"0"` | Set `"1"` to load embedding GGUF |
| `ELIZA_LLAMA_CACHE_TYPE_K` / `_V` | `qjl1_256` / `q4_polar` | KV-cache quant type |
| `ELIZA_MTP` | — | Set `"1"` for MTP speculative decoding |
| `ELIZA_AOSP_TTS_PREWARM` | — | Set `"true"` to pre-warm TTS at boot |
| `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD` | — | Set `"1"` to skip HuggingFace download |
| `ELIZA_AOSP_LLAMA_DEBUG_LOG` | — | Set `"1"` for NDJSON debug log |

See `CLAUDE.md` for the full variable reference.

## Package layout

```
src/
  index.ts                          Barrel (bundle-safety sink included)
  aosp-llama-adapter.ts             bun:ffi loader, AospLlamaAdapter class
  aosp-llama-streaming.ts           Streaming-LLM FFI bindings
  aosp-local-inference-bootstrap.ts Model handler registration, TTS, ASR
  aosp-debug-log.ts                 Append-only debug log utility
__tests__/                          bun test suites
```
