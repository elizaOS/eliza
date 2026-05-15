# silero-vad-cpp — port plan

Standalone C library that ports snakers4/silero-vad's small LSTM-based
voice-activity classifier to the elizaOS/llama.cpp fork's ggml
dispatcher, replacing the `onnxruntime-node` path the runtime currently
uses in `plugins/plugin-local-inference/src/services/voice/vad.ts`.
The end goal is to delete the ONNX dependency from the voice front-end
entirely (see the repo-wide ONNX-removal initiative the parallel
`yolo-cpp` and `doctr-cpp` ports are part of).

This document is the contract the port must satisfy. Today the model
entry points in `include/silero_vad/silero_vad.h` are a **stub**
(`src/silero_vad_stub.c`) that returns `-ENOSYS` for every call. Two
companion TUs are *real* and exercised by ctest already:

- `src/silero_vad_state.c` — pure-C LSTM hidden / cell state container
  with `reset` and `promote` helpers (validated by
  `test/silero_vad_state_test.c`).
- `src/silero_vad_resample.c` — pure-C linear PCM resampler so callers
  running at 8 / 22.05 / 44.1 kHz can normalize to the model's
  required 16 kHz before the model entry points become non-stub
  (validated by `test/silero_vad_resample_test.c`).

The port plan replaces only `silero_vad_stub.c` — the public ABI, the
state struct, and the resampler stay byte-for-byte the same.

## Why this lives here

- `plugins/plugin-local-inference/src/services/voice/vad.ts` declares
  `SileroVad` (the ONNX wrapper) and `NativeSileroVad` (a thin
  bun:ffi wrapper over the libelizainference fused-build's VAD
  surface). Both implement the narrow `VadLike` interface (`process`,
  `reset`, `windowSamples`, `sampleRate`).
- The ONNX path drags `onnxruntime-node` (a 100+ MB native dependency)
  into every electrobun build that wants voice on. The eliza-1
  inference fabric already ships with ggml; the small Silero gate is
  the cheapest possible model to port and the highest-leverage one to
  delete from the dependency surface.
- The state shape is small (`{h_in[64], c_in[64], h_out[64], c_out[64]}`)
  and the model is a single LSTM layer + linear head + sigmoid — every
  op already has a ggml counterpart, so the port is a "wire the graph"
  exercise, not a "teach ggml a new op" exercise.

## Upstream pin

- Repo: https://github.com/snakers4/silero-vad
- License: MIT (compatible with this repo's licensing).
- Commit: **TODO — pin at conversion time and record both here and in
  the GGUF metadata key `silero_vad.upstream_commit`** (see
  `scripts/silero_vad_to_gguf.py`).
- Model: `silero_vad` v5 (the version this port's window size and
  state dimensions are dimensioned around). Roughly 1.7M parameters,
  ~2 MB on disk. Distributed by the upstream as both `.onnx` and
  PyTorch JIT (`.jit`) artifacts; the converter accepts either.

## Model architecture (what the port has to wire)

The v5 graph, after stripping the upstream's pre/post-processing, is:

1. **STFT-style front-end.** A short fixed convolution that maps the
   512-sample mono PCM window into a small bank of band-power features.
   Implementable as a single `ggml_conv_1d` with the upstream weights
   packed in the GGUF.
2. **Encoder block.** Two stacked depthwise + pointwise conv layers
   with LeakyReLU. Standard ggml ops (`ggml_conv_1d`, the activation
   helper).
3. **LSTM layer.** Single layer, 64-dim hidden + 64-dim cell. The fork's
   `ggml_lstm` handles this directly; the per-session state struct in
   `src/silero_vad_state.h` is the storage the runtime threads through
   each step.
4. **Linear head + sigmoid.** One `ggml_mul_mat` plus the standard
   activation helper, output is a scalar in `[0, 1]`.

Total compute per 32 ms window is small enough that a CPU-only build
on a laptop sustains real-time without measurable latency — which is
the whole point of the gate.

## C ABI (frozen by `include/silero_vad/silero_vad.h`)

The stub already implements this surface; the real port must match it
byte-for-byte:

- `silero_vad_open(const char *gguf_path, silero_vad_handle *out)` —
  load a Silero VAD GGUF produced by `scripts/silero_vad_to_gguf.py`.
  Refuses any GGUF whose `silero_vad.variant` key is not
  `SILERO_VAD_VARIANT_V5`.
- `silero_vad_reset_state(silero_vad_handle h)` — zeroes the LSTM
  hidden + cell state (uses `silero_vad_state_reset` against the state
  struct that lives inside the session).
- `silero_vad_process(silero_vad_handle h, const float *pcm_16khz,
  size_t n_samples, float *speech_prob_out)` — run one 32 ms /
  512-sample window at 16 kHz, write a scalar speech probability into
  `*speech_prob_out`. Wrong window size is `-EINVAL`; wrong sample
  rate is the caller's problem (the resampler in
  `silero_vad_resample.c` is what they should use upstream).
- `silero_vad_close(silero_vad_handle h)` — release everything.
  NULL-safe.
- `silero_vad_active_backend(void)` — diagnostics only. Stub returns
  `"stub"`; the real impl returns `"ggml-cpu"`, `"ggml-metal"`, etc.

Threading: reentrant against distinct sessions; sharing one session
across threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOSYS` from the stub,
`-ENOENT` for missing GGUF, `-EINVAL` for shape mismatch / NULL
arguments. No silent fallbacks.

## GGUF conversion (`scripts/silero_vad_to_gguf.py`)

Mirrors the layering already used by
`packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py` and
`packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`:

- one writer, written-once metadata block, all tensors packed in a
  single pass;
- locked block-format constants at the top of the file
  (`MODEL_VARIANT = "silero_vad_v5"`, `WINDOW_SAMPLES = 512`,
  `SAMPLE_RATE_HZ = 16000`);
- pinned upstream commit recorded both in code and in the GGUF
  metadata key — runtime refuses unknown commits;
- `NotImplementedError` in every TODO block so a half-built converter
  cannot pass for working.

The first pass packs all weights as fp16. Later passes can layer the
existing TurboQuant / Q4_POLAR types on the LSTM gate matrices
(largest weight by far) using the same scaffolding the other
converters demonstrate.

## elizaOS/llama.cpp fork integration

The runtime calls live in this library; the fork only needs to expose
its ggml dispatcher and (already-present) `ggml_lstm` op. The
integration plan is:

1. **Bring up the front-end + encoder first.** All conv ops are
   already supported. Validate by running the dummy-input-zero path
   end-to-end and confirming the unprocessed pre-LSTM activation
   matches the upstream Python reference within a small float epsilon.
2. **Wire the LSTM through `ggml_lstm`.** Use the state struct in
   `src/silero_vad_state.h` as the in/out buffer. Confirm that
   `silero_vad_reset_state` followed by N inference steps reproduces
   the upstream Python output stream within tolerance.
3. **Add the linear head + sigmoid.** Single matmul + activation.
4. **Wire to the fork's dispatcher.** The library already advertises
   `silero_vad_active_backend()`; the real impl reports the bound
   backend's name (`ggml-cpu`, `ggml-metal`, etc.).
5. **Replace the stub.** `silero_vad_stub.c` is removed from
   `CMakeLists.txt`; the real implementation TUs (`silero_vad_open.c`,
   `silero_vad_process.c`, etc.) are added in its place. The stub
   smoke test (`test/silero_vad_stub_smoke.c`) is replaced with the
   parity test described below; the state and resample tests stay
   exactly as they are — they are validating utilities the port
   already depends on.

## Replacement of the ONNX path in `vad.ts`

Once `silero_vad_open` returns 0 and the parity tests pass:

- `plugins/plugin-local-inference/src/services/voice/vad-ggml.ts`
  (created in this commit, marked EXPERIMENTAL) becomes the canonical
  TS binding.
- `vad.ts`'s `SileroVad` (the ONNX wrapper) and the entire
  `silero-onnx` provider in `vadProviderOrder` are removed.
- The provider-resolver fallback chain becomes
  `qwen-toolkit → silero-native → silero-ggml` — no ONNX path.
- `onnxruntime-node` is removed from
  `plugins/plugin-local-inference/package.json`.

The `VadLike` interface, the `VadDetector` state machine, and the
event surface (`speech-start`, `speech-active`, `speech-pause`,
`speech-end`, `blip`) all stay unchanged — the binding swap is the
only TS-side change.

## Build (today)

```
cmake -B build -S packages/native-plugins/silero-vad-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libsilero_vad.a` plus three test executables —
`silero_vad_stub_smoke` (asserts every model entry point still returns
`-ENOSYS`), `silero_vad_state_test` (validates the LSTM state
helpers), and `silero_vad_resample_test` (validates the linear PCM
resampler). All three pass on the dev host.

## What's missing before the port is real

- Pinned snakers4/silero-vad upstream commit + recorded weights
  download recipe.
- `discover_tensors`, `load_weights`, `write_gguf` implementations in
  `scripts/silero_vad_to_gguf.py` (TODO blocks call out the exact
  work).
- Real `silero_vad_open` / `_process` / `_reset_state` / `_close` TUs
  that link against the elizaOS/llama.cpp fork's ggml dispatcher.
- Parity test: ingest a short reference audio clip, run both the
  Silero Python reference and this library, assert per-window speech
  probability stays within ±0.02 of the reference for the entire clip.
- Wiring of `vad-ggml.ts` into `vadProviderOrder` once the parity
  test passes; deletion of the ONNX path and the
  `onnxruntime-node` dependency in the same change.
