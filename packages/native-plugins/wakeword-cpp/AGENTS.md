# wakeword-cpp — port plan

Standalone C library that ports
[dscripka/openWakeWord](https://github.com/dscripka/openWakeWord)'s
three-stage streaming wake-word pipeline (melspectrogram → embedding
CNN → dense classifier head) off `onnxruntime-node` and onto the
elizaOS/llama.cpp fork's ggml dispatcher. The output replaces the
ONNX-runtime-backed `OpenWakeWordModel` in
`plugins/plugin-local-inference/src/services/voice/wake-word.ts` with
a native `bun:ffi` binding (`wake-word-ggml.ts` — EXPERIMENTAL while
this port lands).

This document is the contract the port must satisfy. Today the public
ABI in `include/wakeword/wakeword.h` is a **stub** — `wakeword_open` /
`wakeword_process` / `wakeword_set_threshold` / `wakeword_close` all
return `-ENOSYS` from `src/wakeword_stub.c`. The melspectrogram and
sliding-window translation units (`src/wakeword_melspec.c`,
`src/wakeword_window.c`) are real, tested in isolation, and ready to
be linked into the non-stub implementation when Phase 2 brings up the
ggml-backed embedding + classifier graphs.

## Why this lives here

- `plugins/plugin-local-inference/src/services/voice/wake-word.ts`
  loads three ONNX graphs through `onnxruntime-node` to get a
  per-frame P(wake). The CLAUDE.md mandate is to remove all ONNX usage
  from the runtime; this library is the replacement.
- The three-stage shape (melspec / embedding / classifier) maps
  cleanly onto ggml: the melspec is a fixed STFT + mel filter bank
  (no learned weights), the embedding model is a small Conv2D + BN +
  ReLU stack, and the classifier head is 2–3 dense layers.
- Sibling native-plugins (`qjl-cpu`, `polarquant-cpu`,
  `turboquant-cpu`, `doctr-cpp`) already mirror this scaffold pattern:
  a frozen C ABI + an ENOSYS stub today, real ggml-backed TUs landing
  behind the same ABI as the port progresses.

## Upstream pin

- Repo: https://github.com/dscripka/openWakeWord (Apache-2.0)
- Release that ships the three streaming graphs:
  https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1
- Commit pinned in this library: **TODO — record at conversion time
  in `scripts/wakeword_to_gguf.py::WAKEWORD_UPSTREAM_COMMIT` and in
  the GGUF metadata key `wakeword.upstream_commit`**.

The placeholder head bundled in eliza-1 today (`wake/hey-eliza.onnx`)
is the upstream `hey_jarvis_v0.1.onnx` renamed — see the
`OPENWAKEWORD_PLACEHOLDER_HEADS` set in `wake-word.ts`. A real
"hey eliza" head is trained by
`packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`;
that is a separate workstream and is not blocked on this port.

## Three-stage pipeline + GGUF conversion

The runtime will load three GGUFs per session, mirroring the three
ONNX graphs:

| Stage        | ONNX source                  | GGUF metadata `arch`    | Static? |
|--------------|------------------------------|-------------------------|---------|
| melspec      | `melspectrogram.onnx`        | `wakeword-melspec`      | yes (Hann + mel filter bank) |
| embedding    | `embedding_model.onnx`       | `wakeword-embedding`    | no (CNN weights)             |
| classifier   | `<wake-phrase>.onnx`         | `wakeword-classifier`   | no (dense weights)           |

`scripts/wakeword_to_gguf.py` is the single converter. It is a
SKELETON today (every `discover_*_tensors` / `write_gguf` raises
`NotImplementedError`) so a half-built converter cannot pass for
working. The TODO blocks call out the exact work; the structure
mirrors `packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py`.

Locked block-format constants live at the top of that script:

```
MELSPEC_N_MELS    = 32
MELSPEC_HOP       = 160   # 10 ms @ 16 kHz
MELSPEC_WIN       = 400   # 25 ms @ 16 kHz
EMBEDDING_DIM     = 96
EMBEDDING_WINDOW  = 76    # mel frames
HEAD_WINDOW       = 16    # embeddings
```

These are the openWakeWord upstream graph dimensions. The C-side
melspec reference (`src/wakeword_melspec.c`) uses a *different*
first-pass spec (80 mels / 0–8000 Hz / hop 160) so the spectral
correctness unit test can assert a 1 kHz tone lights up the right mel
bin without dragging the full openWakeWord 32-bin float-cluster
filter bank into pure C. Phase 2 reconciles them: the GGUF carries
the openWakeWord-exact 32-bin filter bank as a static tensor, and the
C side stops constructing one at runtime.

## C ABI (frozen by `include/wakeword/wakeword.h`)

The stub already implements this surface; the real port must match it
byte-for-byte:

- `wakeword_open(melspec_gguf, embedding_gguf, classifier_gguf, *out)`
  — load all three GGUFs and prepare a streaming session. The runtime
  will refuse any GGUF whose `wakeword.upstream_commit` /
  `wakeword.melspec_n_mels` / `wakeword.embedding_dim` /
  `wakeword.head_window` keys disagree with this header's pinned
  variants.
- `wakeword_process(h, pcm_16khz, n_samples, *score_out)` — push
  arbitrary 16 kHz mono float PCM, get back the most recent
  classifier probability ∈ [0, 1]. Internally hops on an 80 ms
  boundary (`WW_FRAME_SAMPLES = 1280` in `src/wakeword_internal.h`);
  early calls (before enough mel + embedding context has accumulated)
  return 0.
- `wakeword_set_threshold(h, threshold)` — advisory state stored on
  the session for higher-level callers that want a boolean
  fired/not-fired view. Default `WAKEWORD_DEFAULT_THRESHOLD = 0.5`.
- `wakeword_close(h)` — release everything. NULL-safe.
- `wakeword_active_backend()` — diagnostics. Stub returns `"stub"`;
  the real impl returns `"ggml-cpu"`, `"ggml-metal"`, etc.

Coordinate convention: PCM is 16 kHz mono float in [-1, 1]. Anything
else is `-EINVAL`.

Threading: reentrant against distinct `wakeword_handle` values.
Sharing one handle across threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOSYS` from the stub,
`-ENOENT` for missing GGUF, `-EINVAL` for shape/argument problems,
`-EIO` for a corrupt GGUF. No silent fallbacks.

## elizaOS/llama.cpp fork integration

The port's runtime calls live in this library; the fork only needs
to expose its ggml dispatcher and (optionally) any custom op the
embedding model needs. The integration plan is:

1. **Bring up the melspec first.** It is purely deterministic, has
   no learned weights, and the unit tests in this directory already
   cover spectral correctness. The fork integration here is just
   "load the static Hann window + mel filter bank as ggml tensors and
   reuse `ggml_conv_1d` for the windowed STFT" — and at that point
   the pure-C reference becomes the test oracle.
2. **Bring up the embedding model next.** A small Conv2D + BN + ReLU
   stack ending in a 96-dim pooled output. All ops are stock ggml.
3. **Bring up the classifier head last.** 2–3 dense layers — one
   `ggml_mul_mat` per layer plus a sigmoid on the output.
4. **Wire to the fork's dispatcher.** Mirror the way `polarquant-cpu`
   registers its `block_q4_polar` type — but the wake-word port does
   not introduce a new ggml type, so the wiring is just "select the
   default ggml backend at session-open time and feed it the loaded
   tensors". `wakeword_active_backend()` then reports the bound
   backend's name.
5. **Add a `fork-integration/` directory** if the embedding model
   needs any minimal patches against the fork (none expected for the
   first pass).

## Replacement of `wake-word.ts`

Once `wakeword_open` returns 0 and the parity tests in this directory
pass against the openWakeWord Python reference (1e-3 absolute on
P(wake) over a 1000-clip held-out set), the `bun:ffi` binding at
`plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts`
becomes the default `WakeWordModel` implementation. The
`OpenWakeWordModel` class in `wake-word.ts` then stays as the
fallback while we shake out the new path; once the migration is done
it can be deleted along with the `onnxruntime-node` dependency.

Until that migration lands, `wake-word.ts` is **read-only** for this
port — it documents the contract the new path must satisfy.

## Build (today)

```
cmake -B build -S packages/native-plugins/wakeword-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libwakeword.a` plus three test binaries:

- `wakeword_stub_smoke` — asserts every public ABI entry point still
  returns `-ENOSYS` and that NULL handles do not crash.
- `wakeword_melspec_test` — feeds a 1 kHz and a 4 kHz sine through
  the streaming melspec; asserts the modal mel bin's centre frequency
  lands within ±100 Hz / ±400 Hz of the expected tone.
- `wakeword_window_test` — pushes 5 s of PCM in 100 ms chunks;
  asserts exactly one 80 ms frame is emitted per 1280 samples and
  that frame contents match the source ramp byte-for-byte.

All three pass on the dev host.

## What's missing before the port is real (Phase 2)

- Pinned dscripka/openWakeWord commit + recorded weights download
  recipe.
- `discover_melspec_tensors`, `discover_embedding_tensors`,
  `discover_classifier_tensors`, `write_gguf` implementations in
  `scripts/wakeword_to_gguf.py` (TODO blocks call out the exact
  work).
- ggml-backed embedding-CNN + classifier-MLP TUs that replace the
  ENOSYS stub. The melspec stays mostly C — only the static Hann
  window + mel filter bank move into the GGUF.
- Reconciliation of the C-side first-pass mel filter bank
  (80 mels / 0–8000 Hz) with the openWakeWord upstream filter bank
  (32 mels / float-cluster fmin/fmax). The plan is "drop the
  first-pass C bank, load the upstream bank from the GGUF", not
  "keep both".
- Parity test: ingest the openWakeWord Python reference's per-frame
  P(wake) over a 1000-clip held-out set, assert |Δ| ≤ 1e-3 absolute.
- `fork-integration/` patches if the embedding model needs any new
  ggml ops or quant types (none expected for the first pass).
- `wake-word-ggml.ts` becomes the default `WakeWordModel`
  implementation; `wake-word.ts` and the `onnxruntime-node`
  dependency are removed.
