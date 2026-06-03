# @elizaos/plugin-omnivoice

Local text-to-speech for Eliza agents via omnivoice.cpp (k2-fsa OmniVoice) — voice cloning, voice design, emotion-aware synthesis, and singing on CPU/Metal/CUDA/Vulkan.

## Purpose / role

Registers `ModelType.TEXT_TO_SPEECH` backed by the `libomnivoice` shared library (a Bun FFI binding to the omnivoice.cpp C ABI). Gives an Eliza agent fully local, offline TTS with zero cloud round-trip: voice design by attribute keywords, voice cloning from a reference WAV, and an optional singing codepath using a separate model GGUF. Not enabled by default — auto-enables only when model GGUFs are present at a known path, `OMNIVOICE_MODEL_PATH`+`OMNIVOICE_CODEC_PATH` are set, or `features.localTts` is true in agent config. Browser bundles expose an unavailable entry because native FFI is not present in browsers.

## Plugin surface

This plugin registers model handlers only — no actions, providers, evaluators, or routes.

| Model type | Handler |
|---|---|
| `ModelType.TEXT_TO_SPEECH` | Synthesizes speech or singing from text; returns a WAV `Buffer`. Accepts a plain string or an `OmnivoiceTtsInput` object. |
| `ModelType.TRANSCRIPTION` | Unsupported handler that always throws `OmnivoiceTranscriptionNotSupported`. omnivoice.cpp has no ASR head; pair with plugin-elevenlabs, plugin-deepgram, or Whisper for STT. |

## Layout

```
plugins/plugin-omnivoice/
  src/
    index.ts            Plugin definition (omnivoicePlugin), model handler wiring, settings loader
    index.node.ts       Node/Bun entry re-export (no functional delta)
    index.browser.ts    Browser unavailable entry — throws OmnivoiceNotInstalled for any TTS call
    ffi.ts              bun:ffi binding: OmnivoiceContext class, C ABI struct layouts, dlopen loader
    synth.ts            High-level synthesis: marshals OmnivoiceSynthesizeOptions to C params, pcmFloatToWavBuffer
    singing.ts          Singing model codepath: separate lazy OmnivoiceContext, runSingingSynthesis
    emotion-local.ts    Emotion taxonomy + coercion helpers (local mirror of packages/ui/src/voice/emotion.ts)
    errors.ts           Error classes: OmnivoiceNotInstalled, OmnivoiceModelMissing, OmnivoiceSynthesisFailed, OmnivoiceTranscriptionNotSupported
    discover.ts         Filesystem discovery of GGUF pairs under <stateDir>/models/omnivoice/{speech,singing}/
    shutdown.ts         Process-lifecycle cleanup: registerOmnivoiceShutdownHooks, closeOmnivoiceShutdown
    types.ts            Public TS types: Emotion, OmnivoiceVoiceDesign, OmnivoiceSynthesizeOptions, OmnivoiceSynthesisResult, OmnivoiceContextOptions
  auto-enable.ts        shouldEnable() — probed by elizaOS plugin loader to decide auto-activation
  build.ts              Custom Bun.build script (dual Node + browser build)
  __tests__/            Unit tests (vitest)
```

## Commands

```bash
bun run --cwd plugins/plugin-omnivoice build          # build dist/
bun run --cwd plugins/plugin-omnivoice dev            # incremental build with --hot
bun run --cwd plugins/plugin-omnivoice test           # vitest run
bun run --cwd plugins/plugin-omnivoice lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-omnivoice format         # biome format --write
bun run --cwd plugins/plugin-omnivoice typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-omnivoice clean          # rm -rf dist .turbo
```

## Config / env vars

All vars are read via `runtime.getSetting(key)` first, then `process.env[key]`.

| Var | Required | Default | Description |
|---|---|---|---|
| `OMNIVOICE_MODEL_PATH` | Yes | — | Path to the omnivoice base LM GGUF (e.g. `omnivoice-base-Q8_0.gguf`) |
| `OMNIVOICE_CODEC_PATH` | Yes | — | Path to the omnivoice tokenizer/codec GGUF (e.g. `omnivoice-tokenizer-Q8_0.gguf`) |
| `OMNIVOICE_LIB_PATH` | No | auto-search | Absolute path to `libomnivoice.{so,dylib,dll}`; if omitted, `ffi.ts` searches `packages/inference/omnivoice.cpp/build/` (and `../../` of it) relative to `process.cwd()`. The real build output lives at `plugins/plugin-local-inference/native/omnivoice.cpp/build/`, so set this explicitly unless running from a cwd where the auto-search path resolves |
| `OMNIVOICE_SINGING_MODEL_PATH` | No | — | GGUF for the singing codepath; required only if `singing: true` is passed in TTS input |
| `OMNIVOICE_LANG` | No | `"English"` | Default language hint passed to `ov_tts_params.lang`; `""` = auto-detect |
| `OMNIVOICE_INSTRUCT` | No | — | Default voice-design instruct string (e.g. `"female young adult moderate happy"`) |
| `OMNIVOICE_USE_FA` | No | `true` | Enable flash attention for GPU backend |
| `OMNIVOICE_AUTO_DETECT` | No | `true` | Set to `0`/`false`/`no` to disable filesystem GGUF discovery in auto-enable |
| `ELIZA_STATE_DIR` | No | `~/.eliza` | Per-user state root; `discover.ts` looks for GGUFs under `<stateDir>/models/omnivoice/` |

Auto-enable also responds to agent config `features.localTts: true` or `features.tts: { provider: "omnivoice" }`.

## How to extend

**Add a new synthesis option:**
1. Add the field to `OmnivoiceSynthesizeOptions` in `src/types.ts`.
2. Write the corresponding C-struct field in `src/synth.ts:runSynthesis` using the layout from `OV_TTS_PARAMS_LAYOUT` in `src/ffi.ts`.
3. If omnivoice.h gains a new field, add it to `OV_TTS_PARAMS_LAYOUT` in `src/ffi.ts` (field order and alignment must match the C declaration exactly).

**Add a new model handler:**
1. Add the `ModelType.*` key to the `models` object in `src/index.ts:omnivoicePlugin`.
2. Implement the handler; wire `OmnivoiceContext` from `src/ffi.ts` for any synthesis work.

**Add a new emotion keyword:**
1. Extend the `SYNONYMS` map in `src/emotion-local.ts`.
2. Keep `Emotion` in `src/types.ts` in sync with `packages/ui/src/voice/emotion.ts` — both mirror the same canonical set.

## Conventions / gotchas

- **Bun-only runtime.** The FFI layer uses `bun:ffi` (`dlopen`, `JSCallback`, `ptr`, `toArrayBuffer`). The plugin will throw `OmnivoiceNotInstalled` in Node.js without Bun's native FFI. The browser build exports an unavailable entry that throws on TTS calls.
- **libomnivoice must be built separately.** The shared library is not bundled. Build it with `node plugins/plugin-local-inference/native/build-omnivoice.mjs` from the repo root; it produces `libomnivoice.{so,dylib,dll}` in `plugins/plugin-local-inference/native/omnivoice.cpp/build/`. Set `OMNIVOICE_LIB_PATH` to that file (the C source and ABI header live at `plugins/plugin-local-inference/native/omnivoice.cpp/src/`).
- **GGUFs from HuggingFace.** Download from `https://huggingface.co/Serveurperso/OmniVoice-GGUF`. The speech and codec GGUFs are required independently.
- **C ABI versioning.** `OV_ABI_VERSION = 2` in `ffi.ts` must match the version the shared library was built with. A mismatch causes `ov_init` to return NULL.
- **Struct layouts are manual.** `buildLayout()` in `ffi.ts` mirrors C struct field order and alignment. If `omnivoice.h` changes, update `OV_INIT_PARAMS_LAYOUT`, `OV_AUDIO_LAYOUT`, and `OV_TTS_PARAMS_LAYOUT` in lockstep.
- **Context caching.** Both the speech context (`src/index.ts`) and the singing context (`src/singing.ts`) are cached at module scope for the process lifetime. Shutdown hooks (`src/shutdown.ts`) release them on `beforeExit`/`SIGTERM`/`SIGINT`. Tests use `_resetSingingCache()` and `_clearOmnivoiceClosers()` to reset state between runs.
- **Streaming.** `OmnivoiceContext.synthesize()` accepts an `onChunk` callback (mapped to `ov_audio_chunk_cb` via `bun:ffi` `JSCallback`). The callback returns `false` to cancel. The `JSCallback` handle is closed immediately after `ov_synthesize` returns — do not retain it.
- **Output format.** The model handler returns a 16-bit PCM WAV `Buffer` (44-byte RIFF header + int16 samples), not raw Float32 PCM. `pcmFloatToWavBuffer` in `src/synth.ts` performs the conversion.
- **Unsupported transcription.** The plugin registers `ModelType.TRANSCRIPTION` only to surface a clear error. If your agent needs STT, load a separate plugin.

See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM standards.
