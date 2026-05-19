# @elizaos/plugin-aosp-local-inference

AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and the local-inference
bootstrap that registers `TEXT_SMALL`, `TEXT_LARGE`, `TEXT_EMBEDDING`, and
`TEXT_TO_SPEECH` model handlers on the AOSP mobile agent.

Both exports self-gate on `ELIZA_LOCAL_LLAMA=1` and are no-ops on every
other platform/runtime, so they are safe to import unconditionally from
the mobile agent's static plugin barrel.

## Public surface

- `registerAospLlamaLoader()` — registers the bun:ffi-backed llama loader
  with `@elizaos/agent` when running on AOSP.
- `ensureAospLocalInferenceHandlers()` — registers the text / embedding
  handlers against the AOSP llama loader, plus a Kokoro-backed
  `TEXT_TO_SPEECH` handler that reuses `@elizaos/shared/local-inference`
  discovery/runtime code and emits WAV bytes.

## Layout

```
plugins/plugin-aosp-local-inference/
  src/
    index.ts                              Barrel
    aosp-llama-adapter.ts                 bun:ffi loader registration
    aosp-llama-streaming.ts               Streaming bridge
    aosp-dflash-adapter.ts                DFlash drafter wiring
    aosp-local-inference-bootstrap.ts     Model-handler registrar incl. Kokoro TTS
  __tests__/                              vitest suites
```
