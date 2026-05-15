# doctr-cpp — port plan

Standalone C library that will eventually port mindee/doctr's
detection + recognition heads to the elizaOS/llama.cpp fork's ggml
dispatcher, replacing plugin-vision's transitional
`RapidOcrCoordAdapter` with a native, hierarchical (block / line /
word) OCR provider that computes bbox coords + a coarse 3x3 semantic
position label per element.

This document is the contract the port must satisfy. Today the
library is a **stub**: every entry point in `include/doctr/doctr.h`
returns `-ENOSYS` from `src/doctr_stub.c`. CMake builds the stub plus
a `doctr_stub_smoke` binary that asserts the ABI links. The real port
replaces the stub TUs without changing the ABI.

## Why this lives here

- `plugins/plugin-vision/src/ocr-with-coords.ts` declares the
  `OcrWithCoordsService` interface that plugin-computeruse consumes
  via the `registerCoordOcrProvider` slot in
  `plugins/plugin-computeruse/src/mobile/ocr-provider.ts`.
- The transitional adapter in `ocr-with-coords.ts` wraps
  `RapidOCRService` (PP-OCRv5 over onnxruntime-node). That works for
  Phase 1 but takes us off the eliza-1 inference fabric — the local
  voice / vision tracks already dispatch through the
  elizaOS/llama.cpp fork, and the OCR head should too.
- doctr's two heads are the right shape for that fork:
  `db_resnet50` is a fully-convolutional differentiable-binarization
  detector that maps cleanly onto ggml's conv ops; `crnn_vgg16_bn`
  is a CRNN whose VGG backbone + BiLSTM + CTC head all have ggml
  counterparts.

## Upstream pin

- Repo: https://github.com/mindee/doctr
- Commit: **TODO — pin at conversion time and record both here and in
  the GGUF metadata key `doctr.upstream_commit`** (see
  `scripts/doctr_to_gguf.py`).
- Models the port targets:
  - Detection: `db_resnet50` — DBNet head over a ResNet-50 backbone.
    Letterbox input size 1024. Output: a feature map that postprocess
    turns into axis-aligned bboxes in pixel coordinates.
  - Recognition: `crnn_vgg16_bn` — VGG-16 (with batchnorm) backbone,
    BiLSTM, CTC head. Input crop is height-32, RGB. Output: CTC
    logits → vocab string.

## C ABI (frozen by `include/doctr/doctr.h`)

The stub already implements this surface; the real port must match it
byte-for-byte:

- `doctr_open(const char *gguf_path, doctr_session **out)` — load a
  doctr GGUF produced by `scripts/doctr_to_gguf.py`. Refuses any GGUF
  whose `doctr.detector` / `doctr.recognizer` keys disagree with this
  header's pinned variants.
- `doctr_close(doctr_session *)` — release everything (NULL-safe).
- `doctr_detect(session, image, out, max_detections, *out_count)` —
  run db_resnet50, write up to `max_detections` `doctr_detection`
  records. `-ENOSPC` + filled `*out_count` on overflow so callers can
  resize and re-call.
- `doctr_recognize_word(session, crop, *out)` — run crnn_vgg16_bn over
  a single pre-cropped word image (height 32). Caller-owned UTF-8 +
  per-character confidence buffers; `-ENOSPC` on overflow.
- `doctr_active_backend()` — diagnostics only. Stub returns `"stub"`;
  the real impl returns `"ggml-cpu"`, `"ggml-metal"`, etc.

Coordinate convention: every bbox is `{x, y, width, height}` in
**source-image absolute pixel coordinates** (the caller pre-shifts
tile-local detector output by `sourceX`/`sourceY` — see
`RapidOcrCoordAdapter.describe` in
`plugins/plugin-vision/src/ocr-with-coords.ts`).

Threading: reentrant against distinct sessions; sharing one session
across threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOSYS` from the stub,
`-ENOENT` for missing GGUF, `-EINVAL` for shape mismatch, `-ENOSPC`
for caller-buffer overflow. No silent fallbacks.

## GGUF conversion (`scripts/doctr_to_gguf.py`)

Mirrors the layering in
`packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`:
- one writer, written-once metadata block, all tensors packed in a
  single pass;
- locked block-format constants at the top of the file
  (`DETECTOR_INPUT_SIZE = 1024`, `RECOGNIZER_INPUT_HEIGHT = 32`);
- pinned upstream commit recorded both in code and in the GGUF
  metadata key — runtime refuses unknown commits;
- `NotImplementedError` in every TODO block so a half-built converter
  cannot pass for working.

The first conversion pass packs both heads as fp16. Later passes can
layer `Q4_POLAR` on the recognizer's CTC weights and the detector's
3x3 convs using the same scaffolding `polarquant_to_gguf.py`
demonstrates — the GGUF format already supports per-tensor `raw_dtype`
overrides, so adding a new type number is a one-line change once the
fork registers it in `ggml-common.h`.

## elizaOS/llama.cpp fork integration

The port's runtime calls live in this library; the fork only needs to
expose its ggml dispatcher and (optionally) any custom op the
recognizer's BiLSTM needs. The integration plan is:

1. **Bring up the detector first.** db_resnet50 is purely
   convolutional and uses ops the fork already supports (`ggml_conv_2d`,
   batchnorm via `ggml_norm`, sigmoid via the standard activation).
   The DBNet postprocess (binarization → contour extraction) runs on
   the C side, not in ggml — pick OpenCV-free code from doctr's
   `references/detection/postprocess.py` and port it.
2. **Bring up the recognizer next.** The VGG-16-BN backbone reuses
   the same conv/batchnorm/relu chain. The BiLSTM maps onto
   `ggml_lstm` (already in the fork). The CTC head is one
   `ggml_mul_mat` plus a CPU-side beam decoder.
3. **Wire to the fork's dispatcher.** Expose a single
   `doctr_set_ggml_backend(backend)` setter (mirroring the way
   `polarquant-cpu` registers its block_q4_polar type — see
   `packages/native-plugins/polarquant-cpu/fork-integration/`). The
   stub already advertises `doctr_active_backend()`; the real impl
   reports the bound backend's name.
4. **Add a fork patch directory.** `fork-integration/` will hold the
   minimal set of patches against the fork (e.g. ggml-common.h
   register if a new quant type is required for recognizer weights;
   none expected for the first pass). Mirror the layout used in
   `packages/native-plugins/polarquant-cpu/fork-integration/`.

## Replacement of `RapidOcrCoordAdapter`

Once `doctr_open` returns 0 and the parity tests in this directory
pass, `plugins/plugin-vision/src/ocr-with-coords.ts` swaps the
adapter for a `DoctrCoordOcrService` that calls into this library.
The `OcrWithCoordsService` interface, the per-element semantic
position rule, and the registry slot in
`plugins/plugin-computeruse/src/mobile/ocr-provider.ts` all stay
unchanged — the adapter is the only TS surface that gets deleted.

## Build (today)

```
cmake -B build -S packages/native-plugins/doctr-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output:
- `libdoctr.a` + `doctr_stub_smoke` — Phase 1 ENOSYS stub link guard.
- `libdoctr_ref.a` + `doctr_detector_ref_test` + `doctr_recognizer_ref_test` —
  Phase 2 pure-C reference impl. Both libs satisfy the same C ABI in
  `include/doctr/doctr.h`; consumers link exactly one. Phase 2 reports
  `doctr_active_backend() == "ref-c"`.

## Phase status

- **Phase 1 (ENOSYS stub):** DONE. `libdoctr.a` + smoke test ship and
  pass.
- **Phase 2 (pure-C reference impl):** IMPLEMENTED.
  - GGUF reader (`src/doctr_gguf.c`) — mmap'd v3 reader; F32 + F16
    tensors; metadata strings + uint32; refuses unknown dtypes.
  - Image preprocess (`src/doctr_image.c`) — letterbox-to-1024 for
    detector, plain bilinear-to-32xW for recognizer, doctr ImageNet
    mean/std normalization.
  - NN kernels (`src/doctr_kernels.c`) — Conv2D, BN-fold, BN+ReLU,
    MaxPool2d, bilinear upsample, ConvTranspose2d (2x2 s=2 only),
    sigmoid, Linear, LSTM single-step.
  - Detector forward (`src/doctr_detector_ref.c`) — db_resnet50: stem,
    layer1..4 bottlenecks, FPN (in_branches → top-down sum →
    out_branches → concat), prob_head, sigmoid → DBNet postprocess.
  - Recognizer forward (`src/doctr_recognizer_ref.c`) — VGG-16-BN
    backbone, 2-layer BiLSTM, linear head → CTC greedy decode.
  - DBNet postprocess (`src/doctr_polygon.c`) — binarize + 4-connected
    BFS labelling + axis-aligned bbox + threshold filter; OpenCV-free.
  - CTC greedy decoder (`src/doctr_ctc.c`) — argmax → collapse
    repeats → drop blanks; UTF-8-aware vocab; per-character mean
    softmax confidence.
  - Public ABI (`src/doctr_ref_api.c`) — wraps the ref forward passes;
    validates GGUF metadata against the locked variant tags before
    constructing a session.
  - Conversion script (`scripts/doctr_to_gguf.py`) — working against
    `python-doctr==1.0.1`; downloads pretrained weights, walks both
    state_dicts, emits a single GGUF (~165 MB fp32) with the locked
    metadata keys; round-trips through the C reader.
- **Phase 3 (SIMD dispatch):** PENDING. The conv/gemm/maxpool kernels
  in `src/doctr_kernels.c` are scalar O3 — full forward over a 1024²
  canvas takes minutes, fine for the parity test, far too slow for
  prod. Phase 3 swaps them for AVX2 (x86) / NEON (aarch64) im2col +
  packed GEMM behind the same `doctr_internal.h` API. No ABI change.

## What's missing before the port is real

- Parity fixture: a small set of real document crops with ground-truth
  bboxes + transcriptions, packaged so CI can run both python-doctr
  and this library and assert per-bbox IoU ≥ 0.95, per-word
  edit-distance ≤ 1.
- Bit-exact CTC decode test against weights — the
  `doctr_recognizer_ref_test` covers the weight-free CTC path; the
  end-to-end decode against a labelled crop fixture is PENDING and
  needs the GGUF on the test runner.
- Phase 3 SIMD kernels (above).
- `fork-integration/` patches if Phase 3 grows new ggml ops or quant
  types (none expected for the pure-C ref).
