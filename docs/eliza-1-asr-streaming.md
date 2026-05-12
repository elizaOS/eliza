# Eliza-1 streaming ASR (W7 / A1)

Status: **ABI complete, JS path active, C side opt-in stub provided.**

## What this is

The Eliza-1 voice pipeline needs incremental partial transcripts so the
drafter can start while the user is still speaking (H2 — early drafter
start on `speech-pause`). The fused `libelizainference` library exposes
a stateful streaming-ASR session API for this; the JS pipeline binds it
through `bun:ffi`.

This document describes the contract, the current implementation
status, and how to flip the streaming path on or off.

## ABI surface (`ffi.h`, ABI v3)

Six symbols. All declared in
[`packages/app-core/scripts/omnivoice-fuse/ffi.h`](../packages/app-core/scripts/omnivoice-fuse/ffi.h)
and bound in
[`packages/app-core/src/services/local-inference/voice/ffi-bindings.ts`](../packages/app-core/src/services/local-inference/voice/ffi-bindings.ts).

```c
/* Capability probe — pick streaming vs interim adapter off this flag. */
int eliza_inference_asr_stream_supported(void);

/* Open a session anchored to a context. `sample_rate_hz` of the PCM the
 * caller will feed; the library resamples internally if needed. */
EliAsrStream * eliza_inference_asr_stream_open(
    EliInferenceContext * ctx,
    int sample_rate_hz,
    char ** out_error);

/* Feed PCM samples. Returns samples consumed (>= 0). */
int eliza_inference_asr_stream_feed(
    EliAsrStream * stream,
    const float * pcm,
    size_t n_samples,
    char ** out_error);

/* Read the current running partial. Optional `out_tokens` channel for
 * the fused build's shared text vocab (NULL to skip). */
int eliza_inference_asr_stream_partial(
    EliAsrStream * stream,
    char * out_text, size_t max_text_bytes,
    int * out_tokens, size_t * io_n_tokens,
    char ** out_error);

/* Drain remaining audio, run a final decode pass, emit the final
 * transcript. Session remains valid until `close`. */
int eliza_inference_asr_stream_finish(
    EliAsrStream * stream,
    char * out_text, size_t max_text_bytes,
    int * out_tokens, size_t * io_n_tokens,
    char ** out_error);

/* Close + free a session. Idempotent on NULL. */
void eliza_inference_asr_stream_close(EliAsrStream * stream);
```

Lifecycle: `open → feed* → partial* → finish → close`. The library
owns the internal audio buffer and decoder state; JS never re-submits
earlier audio.

Token-id channel: optional. The fused build shares the Qwen2-BPE text
vocabulary (AGENTS.md §1, §4) so when the streaming decoder is in
place, partials can hand token ids directly to the drafter without
re-tokenization. The current windowed stub emits text only.

## Current implementation status

| Layer | Status | Notes |
|---|---|---|
| C ABI header (`ffi.h`) | Complete | ABI v3, frozen for v1 ship |
| JS FFI binding (`ffi-bindings.ts`) | Complete | All six symbols bound via `bun:ffi`; `asrStreamSupported()` gates the path |
| JS transcriber adapter (`FfiStreamingTranscriber`) | Complete | Implements `StreamingTranscriber`; feed → partial-emit on every frame; flush → finalize |
| C++ canonical impl (`eliza-inference-ffi.cpp`) | **Honest stub** | Returns `ELIZA_ERR_NOT_IMPLEMENTED`; `asr_stream_supported() == 0` per AGENTS.md §3 |
| C++ windowed reference impl (`ffi-streaming-asr.cpp`) | **Opt-in stub** | New file, sliding-window backed by the batch decoder; LocalAgreement-2; gated by `ELIZA_ASR_STREAM_USE_WINDOWED_STUB` |
| Real fused streaming decoder | Not started | Out of scope for W7 — see roadmap |

## Choosing a backend at build time

The JS side dispatches off `asrStreamSupported()`:

```
1. fused streaming ASR (asr_stream_supported() == 1)        ← FINAL path
2. fused batch (interim) — FfiBatchTranscriber               ← active today
3. whisper.cpp legacy interim                                ← fallback
```

To activate the streaming path you need a `libelizainference` build
that reports `asr_stream_supported() == 1`. Two options:

### A. Honest stub (default today)

The canonical `eliza-inference-ffi.cpp` exports the six symbols, but
`asr_stream_supported()` returns 0 and every operation returns
`ELIZA_ERR_NOT_IMPLEMENTED`. JS picks the batch adapter
(`FfiBatchTranscriber`), which already does sliding-window decode in
TypeScript — incremental but driven from JS.

This is the current production path. It works, but the partials are
not as early as a C-side streaming impl: every window round-trips
through `bun:ffi`, and the JS pipeline buffers the utterance before
feeding (see `pipeline.ts::transcribeAll`).

### B. Windowed reference stub (opt-in)

The new file
[`packages/inference/llama.cpp/omnivoice/src/ffi-streaming-asr.cpp`](../packages/inference/llama.cpp/omnivoice/src/ffi-streaming-asr.cpp)
reimplements the six streaming symbols on top of the same fused batch
decoder, but **inside the library**: one session, accumulating its own
audio, doing sliding-window decode with 4.5 s overlap and
LocalAgreement-2 committal.

This is the contract-clean way to wake up the JS streaming path
without waiting on a real streaming decoder. The output is identical
in shape to what the real decoder will produce (text + optional
tokens, monotonically-growing partials, single `finish` event).

To switch on, the build needs to:

1. Add `ffi-streaming-asr.cpp` to the omnivoice target sources.
2. Define `ELIZA_ASR_STREAM_USE_WINDOWED_STUB=1` for that translation
   unit.
3. Exclude the canonical `asr_stream_*` block in `eliza-inference-ffi.cpp`
   from compilation (symbol collision). The cleanest way is to wrap
   that block in `#ifndef ELIZA_ASR_STREAM_USE_WINDOWED_STUB` so the
   define drives both halves.

Pseudo-cmake handoff (the build owner / merge agent wires this):

```cmake
# packages/inference/llama.cpp/omnivoice/CMakeLists.txt — omnivoice target

option(ELIZA_ASR_STREAM_USE_WINDOWED_STUB
       "Enable the sliding-window streaming-ASR stub backed by the batch decoder"
       OFF)

target_sources(omnivoice PRIVATE
    src/eliza-inference-ffi.cpp
    $<$<BOOL:${ELIZA_ASR_STREAM_USE_WINDOWED_STUB}>:src/ffi-streaming-asr.cpp>)

if(ELIZA_ASR_STREAM_USE_WINDOWED_STUB)
    target_compile_definitions(omnivoice PRIVATE
        ELIZA_ASR_STREAM_USE_WINDOWED_STUB=1)
endif()
```

And in `eliza-inference-ffi.cpp` the block at lines 770–844 (the
six `asr_stream_*` stubs) needs to be wrapped:

```c++
#ifndef ELIZA_ASR_STREAM_USE_WINDOWED_STUB
/* ---- Streaming ASR (ABI v2) ---------------------------------------- */
/* ... existing honest-stub block ... */
#endif
```

After this wiring, building with `-DELIZA_ASR_STREAM_USE_WINDOWED_STUB=ON`
produces a library where `asr_stream_supported() == 1` and the JS-side
`FfiStreamingTranscriber` is selected automatically by
`createStreamingTranscriber()`.

## Roadmap to a real streaming decoder

The windowed stub is correct but expensive: every partial re-runs the
encoder on the entire window. A real streaming decoder would maintain
a Qwen3-ASR forward state and process incremental audio frames without
re-encoding earlier audio.

Two paths upstream is tracking:

1. **antirez/qwen-asr-style chunked attention** — process 30 s windows
   with cached KV, advance the cache as new audio arrives. Cheap
   incremental partials (~50–100 ms add per chunk).
2. **Flash-attention streaming Qwen3-ASR** — true frame-incremental
   forward, similar to faster-whisper's streaming mode. Highest
   quality, lowest add latency.

When either lands, drop `ffi-streaming-asr.cpp`, re-implement the same
six symbols against the real decoder, set `asr_stream_supported()` to
return 1 directly in `eliza-inference-ffi.cpp`. JS callers are
unchanged.

## Verifying the streaming path is active

```bash
# 1. JS-side capability probe (works without a real device — runs
#    against the stub dylib in tests, or the real fused build at runtime):
bun run --cwd packages/app-core vitest run \
    src/services/local-inference/voice/ffi-bindings.test.ts

# 2. End-to-end transcriber test (fake ffi, verifies the streaming
#    protocol — feed → partial → words → final):
bun run --cwd packages/app-core vitest run \
    src/services/local-inference/voice/transcriber.test.ts

# 3. Live: in a running voice session, the dev console prints which
#    adapter `createStreamingTranscriber` picked. Look for:
#      [asr] adapter=ffi-streaming  (windowed stub or real decoder active)
#      [asr] adapter=ffi-batch      (fallback — streaming not advertised)
#      [asr] adapter=whisper        (fallback — fused build missing)
```

## Performance expectations

Target (real streaming decoder): **first partial < 200 ms after
`speech-start`**, partial cadence ~150–250 ms.

Current (windowed stub, opt-in): **first partial ≈ window length**
(6.0 s configured, or shorter when speech-end fires earlier). The stub
unlocks the streaming-session protocol so the rest of the pipeline can
be wired and tested, but does not deliver the latency benefit of a
real streaming decoder. The JS-side `FfiBatchTranscriber` already
achieves the same partial cadence with the v1 batch decoder and is
slightly faster because it avoids the C-side LocalAgreement re-decode
overhead.

## Files

- ABI contract: `packages/app-core/scripts/omnivoice-fuse/ffi.h`
- JS FFI binding: `packages/app-core/src/services/local-inference/voice/ffi-bindings.ts`
- JS adapter: `packages/app-core/src/services/local-inference/voice/transcriber.ts` (`FfiStreamingTranscriber`)
- JS pipeline integration: `packages/app-core/src/services/local-inference/voice/pipeline.ts` (`transcribeAll`)
- Canonical C++ impl (honest stub): `packages/inference/llama.cpp/omnivoice/src/eliza-inference-ffi.cpp` (lines 770–844)
- C++ windowed reference impl (opt-in): `packages/inference/llama.cpp/omnivoice/src/ffi-streaming-asr.cpp` (new)
- Tests:
  - `packages/app-core/src/services/local-inference/voice/transcriber.test.ts` (FfiStreamingTranscriber against a fake FFI)
  - `packages/app-core/src/services/local-inference/voice/ffi-bindings.test.ts` (symbol resolution + ABI version check)
