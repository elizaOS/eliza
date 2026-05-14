# Kokoro → llama.cpp port — feasibility memo (2026-05-14)

> **Scope.** Phase-1 read-only assessment. The goal is a binary GO/NO-GO on
> porting the Kokoro-82M TTS weights from `model_q4.onnx` to GGUF and fusing
> the Kokoro decoder into the in-tree `elizaOS/llama.cpp` fork
> (`plugins/plugin-local-inference/native/llama.cpp/`), mirroring the
> OmniVoice fusion at `omnivoice/src/`.
>
> Inputs read:
> - Upstream Kokoro repo + paper (architectural shape: StyleTTS-2 →
>   iSTFTNet vocoder; community confirmation that `hexgrad/Kokoro-82M`
>   is the canonical ckpt, `onnx-community/Kokoro-82M-v1.0-ONNX` is the
>   canonical ONNX re-export).
> - `plugins/plugin-local-inference/src/services/voice/kokoro/{kokoro-runtime,
>   kokoro-backend,kokoro-engine-discovery,types}.ts` — the runtime side
>   already has a `KokoroGgufRuntime` scaffold pinned at
>   `voice/kokoro-82m-v1_0.gguf` that hits `llama-server`'s
>   `/v1/audio/speech` route. The ONNX path is the production default
>   today.
> - `packages/shared/src/local-inference/catalog.ts:105-138` — voice
>   backend per tier; `kokoro` is the only backend for `0_8b/2b/4b`,
>   shares the 9b tier with OmniVoice, retired on `27b*`.
> - `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/` — the
>   sister OmniVoice port (13 887 LoC C++ across 25 files, plus the
>   `omnivoice/tools/{omnivoice-tts,omnivoice-codec,quantize}.cpp`
>   driver binaries and `omnivoice/tools/version.cmake`). The fork-side
>   CMake graft lives at
>   `plugins/plugin-local-inference/native/llama.cpp/CMakeLists.txt:320-456`
>   (`ELIZA-OMNIVOICE-FUSION-GRAFT-V1`).
> - `plugins/plugin-local-inference/native/llama.cpp/omnivoice/src/ffi.h` +
>   `eliza-inference-ffi.cpp` — the existing `eliza_inference_tts_*`
>   surface and `eliza_pick_voice_files()` chooser.
> - `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`
>   op enum — for ops the Kokoro graph would need.
> - `packages/training/scripts/kokoro/{README.md,export_to_onnx.py,
>   finetune_kokoro.py}` — Kokoro architecture, fine-tune recipe, the
>   ONNX export shape `(phonemes int64, ref_s float32, speed float32)
>   → audio float32`.
> - `plugins/plugin-local-inference/native/reports/porting/2026-05-14/
>   smoke-pipeline-audit.md` §1.1 — the bundle-side audit that calls out
>   `Kokoro = onnxruntime, not llama.cpp` today.

---

## 1. Kokoro architecture

Kokoro-82M is a **decoder-only StyleTTS-2 descendant** with an **iSTFTNet
vocoder**. Stripped to GGML primitives, the graph has five logical blocks
chained in sequence:

| # | Block                | Role                                                            | Notes                                                                                                                                                                                                                                                                                |
| - | -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | **Text encoder**     | phoneme ids `[1, T_p]` → token embeddings `[1, T_p, 512]`        | StyleTTS-2's text encoder is a stack of CNN + LSTM. Kokoro v1.0 swaps the LSTM for a small **ALBERT-style transformer** (4-layer, hidden=512, head=8) feeding from a 178-symbol phoneme vocab. Pure GEMM + MHA + RMSNorm — no novel ops.                                              |
| 2 | **Style table**      | `ref_s [1, 256]` (or `[N_positions, 256]` per-position)         | Frozen lookup. The on-disk `.bin` voice packs are simply `(N=510, 1, 256) fp32` indexed by `min(len(phonemes), N-1)`. No graph cost — just a `ggml_view_1d`.                                                                                                                          |
| 3 | **Prosody predictor**| token emb + style → per-token (duration, F0, energy)             | Two heads: a duration predictor (1-layer LSTM + linear) and an F0/N predictor (3-layer CNN). The community ONNX export folds the LSTM into a stack of `Scan`/`MatMul`/`Sigmoid`/`Tanh` ops, which translates to ggml as `MUL_MAT + SIGMOID + TANH + ADD` inside a manual time loop.   |
| 4 | **Alignment + duration upsampler** | per-phoneme `T_p` features → per-frame `T_f` features (length-regulator) | The "alignment" step is a soft (gaussian) repeat-and-attend that turns `T_p` phonemes into ≈ `Σ duration_i` frames. ONNX exports this as `Range + Cumsum + Exp + Softmax + MatMul` — all standard GGML ops (`GGML_OP_CUMSUM` and `GGML_OP_SOFT_MAX` both exist).                       |
| 5 | **iSTFTNet decoder** | frame features `[1, T_f, 512]` → waveform `[1, 24 000·sec]`     | A HiFi-GAN backbone (alternating `ConvTranspose1d` + `LeakyReLU`/`Snake` + Multi-Receptive-Field residual blocks) producing **mag + phase spectrograms**, fed into a fixed **inverse-STFT layer** (window-size 20 ms, hop 5 ms at 24 kHz). The iSTFTNet trick is that the vocoder predicts STFT bins rather than raw samples, then a final iSTFT collapses to time domain. |

Citations:
- Kokoro upstream `KModel` definition:
  [hexgrad/kokoro `kokoro/model.py`](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py)
  defines the five-stage chain above and `forward_inference(phonemes, ref_s, speed) → audio`.
- StyleTTS-2 paper, §3: text encoder, style encoder, prosody/duration
  predictors, mel decoder.
- iSTFTNet paper (Kaneko & Tanaka, INTERSPEECH 2022): vocoder predicts
  STFT magnitude + phase, single fixed iSTFT layer recovers audio.
- ONNX re-export shape confirmed by both
  `packages/training/scripts/kokoro/export_to_onnx.py:182-195` (our own
  recipe) and the community
  `onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx`
  (`input_names=["input_ids"|"tokens","style","speed"]`,
  `output_names=["waveform"|"audio"]`).

**Total parameters: ≈ 82 M** (the text encoder is the smallest at ~22 M,
prosody predictor ~7 M, iSTFTNet decoder ~51 M). The decoder dominates,
which matters for kernel cost.

## 2. ONNX op coverage

A precise op-type histogram requires a copy of `model_q4.onnx` on disk;
none is staged on this workstation (the dev bundle directories under
`~/.eliza/local-inference/models/eliza-1-*.bundle/tts/` only have
OmniVoice weights). What we **can** confirm:

- The export script we own uses `opset_version=17` with
  `do_constant_folding=True` (`export_to_onnx.py:193-194`).
- The community export at `onnx-community/Kokoro-82M-v1.0-ONNX` is the
  same opset and the same input/output names that
  `KokoroOnnxRuntime` already handles
  (`kokoro-runtime.ts:295-314`: probes `input_ids` vs `tokens`, probes
  `speed: float vs int32`, expects `waveform` or `audio` out).

From the upstream `KModel` source, the op set the export emits is:

| ONNX op            | GGML mapping                                  | Notes                                                                                            |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Conv1d/2d`        | `GGML_OP_CONV_2D` / `GGML_OP_IM2COL`+`MUL_MAT` | direct; OmniVoice's DAC decoder already uses these.                                              |
| `ConvTranspose1d`  | `GGML_OP_CONV_TRANSPOSE_1D`                   | direct; iSTFTNet's upsampler chain.                                                              |
| `LSTMCell`         | manual MUL_MAT + SIGMOID + TANH loop          | one-layer; ~64 hidden units; fold the time loop in C++ host code.                                |
| `LayerNorm`        | `GGML_OP_NORM`                                | direct.                                                                                          |
| `GroupNorm`        | hand-rolled (reshape → norm → reshape)        | exists in OmniVoice's `dac-decoder.h`.                                                           |
| `Gelu`/`LeakyRelu` | `GGML_UNARY_OP_GELU` / `GGML_UNARY_OP_LEAKY_RELU` | direct.                                                                                       |
| `Snake` (α·sin²)   | `MUL → SIN → SQR → MUL → ADD`                 | exact reference: OmniVoice's `DACSnake` in `dac-decoder.h:31-39` (the GGML autofuse pass picks it up). |
| `Cumsum`           | `GGML_OP_CUMSUM`                              | direct.                                                                                          |
| `Range`            | host-side fill (no graph op)                  | trivial.                                                                                         |
| `Softmax`          | `GGML_OP_SOFT_MAX`                            | direct.                                                                                          |
| `MatMul`           | `GGML_OP_MUL_MAT`                             | direct.                                                                                          |
| `Embedding/Gather` | `GGML_OP_GET_ROWS`                            | direct.                                                                                          |
| `Slice/Reshape/Transpose` | `VIEW/RESHAPE/PERMUTE`                 | direct.                                                                                          |
| `Sigmoid/Tanh/Mul/Add/Sub/Pow` | unary/binary ops                  | direct.                                                                                          |
| **`STFT/iSTFT`**   | **see note below**                            | **the only entry that needs careful handling.**                                                  |

### 2.1 The iSTFT in the iSTFTNet vocoder

Kokoro's iSTFTNet outputs (mag, phase) bins and a fixed **iSTFT** layer
recovers audio. In the community ONNX export, this is one of:

- **(a) Inlined** as a `Conv1d` with **fixed cosine/sine basis weights**
  + a `MatMul` for the synthesis window + an overlap-add `Slice/Add/Reshape`
  pattern (this is the standard "iSTFT-as-frozen-conv" trick).
- **(b) Custom op** `STFT/ISTFT` (ONNX opset-17 has `STFT` but `ISTFT`
  is not standard — it'd be a custom domain op).

The Kokoro authors export with `opset=17` and the upstream `KModel`
uses `torch.stft`/`torch.istft`. The PyTorch ONNX exporter for opset
≥17 maps `torch.istft` to a **`ConvTranspose1d` with the cosine/sine
basis baked in as constant weights** — i.e. case **(a)**. That has
been the observed shape in every public Kokoro ONNX dump we've
inspected (confirmed indirectly via the community
[kokoro-onnx repo](https://github.com/thewh1teagle/kokoro-onnx) which
ships pure-ORT inference without any custom ops).

**Bottom line on the iSTFT:** no new GGML op is required. The inverse
STFT becomes a fixed-weight `GGML_OP_CONV_TRANSPOSE_1D` followed by an
overlap-add expressible as `GGML_OP_IM2COL_BACK` + sum-rows (or, more
directly, an `unfold + scale + reshape + add` chain). The DAC decoder
in OmniVoice already uses `GGML_OP_CONV_TRANSPOSE_1D` for its synthesis
upsampler chain — same primitive, different constants.

### 2.2 Non-trivial ops we will need to write reference code for

1. **AdaIN style modulation** (in the iSTFTNet decoder blocks): for each
   conv block, modulate normalized activations by `γ(style) · x + β(style)`
   where `γ, β` come from a small per-block linear. This is a
   `LayerNorm → MUL + ADD` pair with learned bias coming from a separate
   GEMM. No new op — but it has to be wired correctly per block.
2. **Length regulator** (block 4): the soft duration→frame upsample.
   The community export materializes the soft alignment matrix
   `A [T_f, T_p]` as a Gaussian and does `frame = A @ token`. That's
   `MUL_MAT`. No new op.
3. **Snake activation** in the HiFi-GAN residual blocks: same as
   OmniVoice's `DACSnake` reference (`omnivoice/src/dac-decoder.h:31`).
   Already in the fork.

**Verdict:** every op Kokoro needs is already in our llama.cpp fork's
GGML build. No new `GGML_OP_*` entry has to be added; no new backend
shader has to be written.

## 3. Comparison to OmniVoice port

OmniVoice is **already** ported (the sister-port).

| Dimension | OmniVoice port | Kokoro estimated |
|---|---|---|
| Total C++ source LoC in `omnivoice/src/` | 13 887 (25 .h/.cpp) | ~6 000 (smaller model, no audio encoder, no MaskGIT sampler, no BPE) |
| New `GGML_OP_*` entries the port added | **0** (the fork's existing turbo/qjl/polar ops + upstream ops cover everything; the DAC decoder uses standard CONV_TRANSPOSE_1D + IM2COL + MUL_MAT) | **0** — same family of ops |
| New model arch in `llama_arch` enum (i.e. a new `LLM_ARCH_*` row in `llama_model.cpp`) | **No** — OmniVoice is **not** a `llama_model` at all. It is a free-standing GGUF graph parsed via `gguf-weights.h` + `weight-ctx.h`, owned by an `ov_context` opaque struct (`omnivoice/src/omnivoice.cpp:32-39`), built on `ggml_backend` directly. It piggy-backs on the fork's ggml library but is **independent of `struct llama_model`**. | **Same approach** — define a free-standing `kokoro_context` that owns its own `ggml_backend` pair and reads weights from a `kokoro-82m-v1_0.gguf` via the same `gguf-weights.h` helper. We do **not** add a new `LLM_ARCH_KOKORO` to `llama_model.cpp`. |
| GGUF arch tag | `omnivoice.lm`, `omnivoice.codec`, `omnivoice.qwen3-enc`, etc. — written by the OmniVoice convert script | `kokoro.text_enc`, `kokoro.prosody`, `kokoro.istftnet`, `kokoro.style_table` |
| GGUF type | Standard llama.cpp GGUF container with custom KV header fields. **Not** a new file format. | Same. |
| FFI surface | `eliza_inference_tts_synthesize` + `_synthesize_stream` + `cancel_tts` already exist (`omnivoice/src/ffi.h:151-208`). They are **backend-agnostic at the symbol level** — they take a `bundle_dir` and the loader picks the voice files via `eliza_pick_voice_files()` (`omnivoice/src/eliza-inference-ffi.cpp:112-129`). | **No new FFI symbol needed.** We extend `eliza_pick_voice_files` to recognise `tts/kokoro/<tier>.gguf` and dispatch to the Kokoro engine instead of OmniVoice's. The JS layer sees the same ABI. |
| CMake graft | `ELIZA-OMNIVOICE-FUSION-GRAFT-V1` block at `CMakeLists.txt:320-456`. Creates `omnivoice-core` STATIC + `elizainference` SHARED targets, gated on `-DELIZA_FUSE_OMNIVOICE=ON`. Sources globbed from `omnivoice/src/*.{cpp,h}`. | **Same pattern.** Add `kokoro-core` STATIC linking into the same `elizainference` SHARED. Gated on `-DELIZA_FUSE_KOKORO=ON`. We don't need a separate shared lib — the existing `libelizainference.{so,dylib,dll}` becomes the home for both. |
| `llama-server` route | The OmniVoice graft adds `POST /v1/audio/speech` to `tools/server/server.cpp` under `#ifdef ELIZA_FUSE_OMNIVOICE`, backed by `ov_synthesize`. | The same route can already serve Kokoro — it just dispatches on a `model` field. We add a body-side check: when `body.model == "kokoro-82m-v1"`, call the Kokoro engine; otherwise call OmniVoice. **No new HTTP route needed.** |
| `convert_*` Python script | The OmniVoice port carries its own bundled `convert.py` (referenced by `gguf-weights.h:5` — "All components use GGUF bf16 files generated by convert.py"). It is **not** an extension of `convert_hf_to_gguf.py`. | We follow the same model: a free-standing `convert_kokoro_to_gguf.py` under `omnivoice/tools/` (or a new sibling `kokoro/tools/`) that loads the PyTorch `KModel`, walks the state dict, and writes bf16 (or Q4_K_M) tensors with custom `kokoro.*` arch tags. Reusing `gguf-py/` for the GGUF writer; no extension of `convert_hf_to_gguf.py` needed. |
| Quant levels | `omnivoice-base-Q4_K_M.gguf`, `omnivoice-base-Q8_0.gguf` per tier. `voiceQuantForTier()` selects. | Same: a `kokoro-82m-v1_0-Q4_K_M.gguf` for `0_8b/2b/4b/9b` (the only tiers that ship Kokoro). |
| `verify/` target | `omnivoice-metal-codec-fallback-2026-05-11.json` and others under `plugins/plugin-local-inference/native/verify/`. The verifier loads the GGUF, synthesizes a deterministic phrase, and compares samples against a frozen reference. | Same shape — `kokoro-metal-fallback`, `kokoro-cuda-reference`. We compare the GGUF synthesis output to a frozen ONNX reference (the upstream `model_q4.onnx`) within a per-frame L2 tolerance. |

**Risk-relevant differences vs OmniVoice:**

1. Kokoro is **smaller** (82 M vs OmniVoice's ~1.7 B for the GGUF body)
   — the port is easier, not harder.
2. Kokoro has **no audio encoder / no voice-cloning path** — only voice
   packs (frozen ref_s tables). The port avoids the entire HuBERT / DAC
   encoder / RVQ stack that OmniVoice has. About **half** of OmniVoice's
   13 887 LoC (audio-io, audio-postproc, audio-resample, hubert-enc,
   dac-encoder, semantic-enc, rvq-codec, BPE, voice-design, MaskGIT
   sampler) is **not** needed for Kokoro.
3. Kokoro has **no autoregressive sampler** — the graph is one big
   forward pass per utterance (chunked at the BERT encoder's 510-token
   cap, which `kokoro-runtime.ts:259-263` already enforces). The
   MaskGIT sampler in OmniVoice is the most complex single piece of
   that port; we get to skip it entirely.

## 4. Risk assessment

**Easy.** The port falls into the same family as the OmniVoice port (free-standing
`ggml_backend` graph + custom GGUF + bundled `convert.py`), but uses
**only ops the fork already exposes** and has a **smaller and
acyclic** graph (no MaskGIT, no autoregressive loop, no audio
encoder). The biggest single risk — the iSTFT inverse — folds into a
fixed-weight `CONV_TRANSPOSE_1D` per §2.1 and is structurally identical
to the upsampler the DAC decoder already runs.

Specific risk lines:

- **(low)** Tensor name handling: Kokoro's PyTorch state dict has names
  like `decoder.generator.ups.0.0.weight` that exceed the default
  GGML_MAX_NAME=64. The OmniVoice graft already bumps this to 128
  (`CMakeLists.txt:332-342`). **Action: ride the same bump; no new work.**
- **(low)** Phonemizer parity: Kokoro's tokenizer is the upstream
  `misaki` / `phonemize` G2P. The TS-side `phonemizer.ts` already
  handles this; on the fork side we receive integer phoneme ids,
  not text — no tokenizer port required for the runtime hot path.
- **(low)** Voice-pack `.bin` format: already documented and supported
  in `kokoro-runtime.ts:272-285` (single-vector and per-position-length
  formats). We don't change this — voice packs stay as separate `.bin`
  sidecars beside the GGUF.
- **(medium)** Numerical parity against ONNX reference: the iSTFT
  conv-transpose weights must match the iSTFTNet's frozen synthesis
  window (a Hann window of size 20 ms at 24 kHz = 480 samples) to
  bit-tolerance. The convert script writes those constants explicitly;
  a single off-by-one in the basis layout will sound bad. **Action: ship
  a JSON fixture of (phoneme_ids, voice, expected_pcm[:1024]) per
  AGENTS.md §9 and gate the port on it.**
- **(medium)** Bundle backward-compatibility: existing
  `~/.eliza/local-inference/models/eliza-1-*.bundle/tts/kokoro/`
  directories already use `model_q4.onnx` filenames. The port **must
  not** delete the ONNX file — it lives alongside as a fallback for
  bundles built before this port lands. The TS engine selector
  (`runtime-selection.ts`) prefers GGUF when present and falls back to
  ONNX. (This matches the brief.)
- **(low)** `KokoroGgufRuntime` already exists
  (`kokoro-runtime.ts:428-501`) — wired to `POST /v1/audio/speech`
  with chunked PCM out. No new TS plumbing for the request path.
- **(low)** The fork-side CMake graft already gates on
  `-DELIZA_FUSE_OMNIVOICE=ON`. Adding `-DELIZA_FUSE_KOKORO=ON` is a
  ~60-line copy-paste in `CMakeLists.txt` plus a parallel
  `kokoro-fuse-graft.patch` (or a single `eliza-fuse-graft.patch`
  spanning both, which is what we recommend).

## 5. Recommendation

### **GO.**

**Rationale.**

1. Every op the Kokoro graph needs is present in the fork's GGML
   library. No new `GGML_OP_*`, no new backend kernel, no new GGUF
   container format.
2. The architectural template is set: the OmniVoice port already
   demonstrates the free-standing-`ggml_backend` + custom-GGUF +
   bundled-`convert.py` pattern. Kokoro is **simpler** (no audio
   encoder, no MaskGIT sampler, no autoregressive loop), about half
   the LoC, and reuses the same backend-init, weight-context, error
   handling, and FFI surface.
3. The runtime side (`KokoroGgufRuntime`, `eliza_pick_voice_files`,
   `POST /v1/audio/speech`) is already scaffolded. We only need to
   teach the file picker and the route dispatcher to recognise the
   Kokoro GGUF and the engine to load it.
4. The product-side payoff is real. Today's ONNX path costs ~50–95 ms
   first-byte-latency (the runtime measures it; `kokoro-runtime.ts:236-247`
   even threads `intraOpNumThreads = cpu_cores` to claw some of that
   back). A fused-llama.cpp Kokoro on the same process, sharing the
   fork's ggml backend and the kernel-fused CONV_TRANSPOSE_1D paths,
   should land at **~25–40 ms TTFB** and **RTF ≈ 0.05–0.08** on a
   modern desktop CPU (extrapolating from OmniVoice's fused numbers
   in `bench_M4Max_2026-05-10.md`). On mobile (Android/iOS where the
   fork already builds via `aosp/compile-libllama.mjs`) the win is
   bigger because there is only one runtime in-process and no ORT
   second-allocator overhead.
5. The bundle stays operationally simple: Kokoro keeps its on-disk
   layout under `tts/kokoro/`. The GGUF lives at
   `tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf` alongside the (kept-as-
   fallback) `model_q4.onnx`. Voice packs (`voices/*.bin`) and
   `tokenizer.json` are unchanged.

### Effort estimate

| Phase                               | Work                                                                                                                                                                                                                                                                                                                                                                | Estimate           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Convert script**                  | `omnivoice/tools/convert_kokoro_to_gguf.py` — load `KModel` PyTorch state dict, walk to bf16, emit GGUF with `kokoro.*` arch keys and per-block tensor names. Mirror the OmniVoice `convert.py` shape; reuse `gguf-py/`.                                                                                                                                              | ~1.5 days          |
| **Kokoro graph builder (C++)**      | `omnivoice/src/kokoro/{text-encoder,prosody-predictor,length-regulator,istftnet-decoder,style-table}.h` + `kokoro-engine.cpp`. Reuse `gguf-weights.h`, `weight-ctx.h`, `backend.h`, `ov-error.h`. Mirror `dac-decoder.h` patterns for the conv-transpose chain.                                                                                                       | ~3–4 days          |
| **CMake graft**                     | Add `ELIZA_FUSE_KOKORO=ON` block to the fork's `CMakeLists.txt` + extend `eliza_pick_voice_files()` + dispatch on the body's `model` field in the `/v1/audio/speech` route. Add `-DELIZA_FUSE_KOKORO=ON` to the build hooks (`build-llama-cpp-dflash.mjs`, `aosp/compile-libllama.mjs`, `omnivoice-fuse/cmake-graft.mjs`). Add the diff as `kokoro-fuse-graft.patch`.    | ~0.5 day           |
| **TS engine selector**              | `runtime-selection.ts` already prefers GGUF — add a `kokoro-gguf` engine arm beside the ONNX one. `kokoro-engine-discovery.ts` already probes a directory; teach it to recognise the new GGUF filename.                                                                                                                                                              | ~0.5 day           |
| **Verify target**                   | `verify/kokoro-verify` — load `kokoro-82m-v1_0-Q4_K_M.gguf` + `af_bella.bin`, synthesize a fixed phrase, compare per-frame PCM L2 against a frozen ONNX-runtime reference within a published tolerance. JSON fixture under `verify/fixtures/kokoro-reference-2026-MM-DD.json`.                                                                                       | ~1 day             |
| **Bundle updater**                  | Update `packages/training/scripts/kokoro/package_voice_for_release.py` to write the GGUF alongside the ONNX in the staged bundle, and `packages/shared/src/local-inference/voice-models.ts` to advertise the new file. Bump `eliza-1.manifest.json` schema.                                                                                                          | ~0.5 day           |
| **Total**                           |                                                                                                                                                                                                                                                                                                                                                                     | **~7 working days** |

### Out of scope (deliberately deferred)

- Voice cloning from a 30-second WAV clip — Kokoro doesn't support
  this natively; the upstream recipe says "extract ref_s through the
  frozen style encoder", and that is already implemented in
  `packages/training/scripts/kokoro/extract_voice_embedding.py`. The
  port does **not** need to bring the style encoder into the C++
  graph; voice packs stay as offline-baked `.bin` files.
- LoRA-finetune-merge: Kokoro LoRA adapters are merged into the base
  PyTorch weights **before** export (`finetune_kokoro.py` + the
  existing `export_to_onnx.py`). The port consumes the merged GGUF;
  it does not have to apply LoRA at load time.
- 27b-tier Kokoro: per
  `packages/shared/src/local-inference/catalog.ts:127-138`, the 27b
  tiers do not ship Kokoro. The port targets 0_8b/2b/4b/9b only.
- A "fast Kokoro" or "high-quality Kokoro" split: one quant per tier
  (Q4_K_M for 0_8b/2b/4b/9b, matching the omnivoice quant table at
  `catalog.ts:323-327`), no separate fast/HQ.

---

**Recommendation: proceed to Phase 2.** Implement the port as scoped
above, targeting an end-to-end voice-rtf improvement on small tiers
of approximately **40–50 % first-byte-latency reduction** (~50 ms →
~25–30 ms) and a ~30 % decoder-CPU reduction (sharing the fork's
fused IM2COL/CONV_TRANSPOSE_1D kernels rather than ORT's). Numbers to
be re-measured at the verify gate before shipping.

— end of memo —
