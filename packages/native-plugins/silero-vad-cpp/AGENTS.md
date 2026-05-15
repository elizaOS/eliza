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
- Commit: **`980b17e9d56463e51393a8d92ded473f1b17896a`** (recorded
  here and as `SILERO_VAD_UPSTREAM_COMMIT` in
  `scripts/silero_vad_to_gguf.py`; the runtime reads the same value
  from the GGUF metadata key `silero_vad.upstream_commit`).
- Model: `silero_vad` v5, **16 kHz branch** of the upstream ONNX
  bundle. The ONNX wraps both 8 kHz and 16 kHz models behind a
  top-level `If(Equal(sr, 16000))` node; the converter targets the
  `then_branch` and ignores the `else_branch`. ~235k parameters,
  ~600 KB on disk as fp16 GGUF.
- Source format: ONNX only. The TorchScript JIT path is intentionally
  unsupported by the converter — supporting both doubles the breakage
  surface and the ONNX is the canonical artifact upstream tests
  against.

## Model architecture (what the port wires)

The v5 16 kHz graph, after stripping the upstream's sample-rate
conditional and ONNX-export sludge, is:

1. **Per-call context carry.** Each call prepends the last 64 samples
   of the previous window to the current 512-sample window. On a
   fresh session (or after `silero_vad_reset_state`) the carry is
   zero. This mirrors `OnnxWrapper._context` in
   `silero_vad/utils_vad.py`; without it the per-window probability
   drifts from the upstream reference by 0.1+ on speech-like inputs.
2. **STFT front-end.** Reflection-pad the (context+window) buffer
   right-side by 64 samples → 640. Conv1D(in=1, out=258, k=256,
   stride=128) with the fixed `stft.forward_basis_buffer` weights
   produces 4 frames; the first 129 channels are the STFT real part,
   the next 129 the imaginary part. Magnitude
   `sqrt(real^2 + imag^2)` collapses the 258 channels to 129 bins.
3. **Encoder.** Four stacked `Conv1D + ReLU` layers with strides
   `(1, 2, 2, 1)` taking (129, 4) → (128, 4) → (64, 2) → (64, 1) →
   (128, 1). All are kernel=3 / pad=1.
4. **LSTM.** Single layer, **128-dim hidden + 128-dim cell** (NOT 64
   as Phase 1 mistakenly recorded — the v5 ONNX model's `state`
   input is shaped `[2, B, 128]`). PyTorch gate order
   (`i, f, g, o`). One timestep per window. The per-session state
   struct in `src/silero_vad_state.h` carries `h_in`, `c_in` from
   the previous window.
5. **Output head.** ReLU(h_out) → 1×1 Conv1D 128→1 → sigmoid → scalar
   speech probability in `[0, 1]`.

Total compute per 32 ms window is small enough that a CPU-only build
on a laptop sustains real-time well below 1% of the 32 ms hop — which
is the whole point of the gate.

The Phase 2 implementation in `src/silero_vad_runtime.c` is pure-C
scalar (no SIMD, no link to libggml). The `silero_vad_active_backend()`
diagnostic returns `"native-cpu"`. A future pass can swap in an
AVX2/NEON dispatcher (or the ggml CPU backend) and report the change
through that field without touching the rest of the ABI.

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
- `silero_vad_active_backend(void)` — diagnostics only. The Phase 2
  implementation returns `"native-cpu"`. A future SIMD or ggml
  dispatcher can change the value here without touching the ABI.

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
# convert weights once before running the runtime ctest:
python3 packages/native-plugins/silero-vad-cpp/scripts/silero_vad_to_gguf.py \
    --output build/silero-vad-v5.gguf
ctest --test-dir build --output-on-failure
```

Outputs:
- `libsilero_vad.a` — static library.
- `libsilero_vad.so` (`.dylib` / `.dll`) — shared library, dlopen'd
  by the bun:ffi binding in
  `plugins/plugin-local-inference/src/services/voice/vad-ggml.ts`.
- `silero_vad_stub_smoke` — confirms the public ABI links and the
  runtime's error paths behave per the header (`-ENOENT` on missing
  GGUF, `-EINVAL` on NULL/wrong-arg, etc.).
- `silero_vad_state_test` — validates the LSTM state helpers.
- `silero_vad_resample_test` — validates the linear PCM resampler.
- `silero_vad_runtime_test` — loads `build/silero-vad-v5.gguf`, runs
  silence + a synthesized speech-like signal, asserts the model
  differentiates them and probabilities stay in `[0, 1]`. Refuses to
  run without the fixture (so a forgotten conversion step shows up
  as a hard test failure, not a silent skip).

A separate Python parity test
(`test/silero_vad_parity_test.py`) runs the C library and the
upstream `silero_vad.OnnxWrapper` (which thread the same 64-sample
context carry) over a 5 s mixed speech/silence fixture and asserts
per-window probability agreement within ±0.02. Verified on the dev
host: mean diff 1.8e-4, p95 6.2e-4, max 4.1e-3, 0 / 156 windows over
threshold.

## Phase 2 status (delivered)

- Pinned snakers4/silero-vad upstream commit
  (`980b17e9d56463e51393a8d92ded473f1b17896a`) + automatic download
  in the converter when `--weights` is omitted.
- Real `discover_tensors` and `write_gguf` in
  `scripts/silero_vad_to_gguf.py` — emits a ~600 KB fp16 GGUF with
  the v5 16 kHz weights and locked metadata keys.
- Real `silero_vad_open` / `_process` / `_reset_state` / `_close` /
  `_active_backend` in `src/silero_vad_runtime.c` (replacing the
  Phase 1 ENOSYS stub, which is gone). Pure-C scalar; no link to
  libggml.
- Parity test (`test/silero_vad_parity_test.py`) and runtime test
  (`test/silero_vad_runtime_test.c`) both passing.
- `vad-ggml.ts` dlopens the new shared library via `bun:ffi`;
  `vadProviderOrder` in `vad.ts` puts the new `silero-cpp` provider
  ahead of the legacy `silero-ggml` (libelizainference) provider.

## What's still ahead

- TurboQuant / Q4_POLAR on the LSTM gate matrices (largest weight
  block; current GGUF is fp16 only).
- AVX2 / NEON dispatch behind the same internal kernel API.
- Production soak then deletion of the legacy libelizainference
  `silero-ggml` provider once `silero-cpp` has demonstrated parity in
  the wild.
