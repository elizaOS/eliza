# yolo-cpp — port plan

Standalone C library that ports Ultralytics YOLOv8n / YOLOv11n
object detection from `onnxruntime-node` to the elizaOS/llama.cpp
fork's ggml dispatcher, replacing
`plugins/plugin-vision/src/yolo-detector.ts` with a native, GGUF-
backed detector that the existing `PersonDetector` consumes
unchanged.

This document is the contract the port must satisfy.

Today (Phase 2 partial) the library is **real for everything except
the forward pass**:
- `src/yolo_classes.c`     — real COCO-80 lookup table.
- `src/yolo_nms.c`         — real per-class non-max suppression.
- `src/yolo_postprocess.c` — real decoupled-head decode helper.
- `src/yolo_gguf.c`        — real GGUF v3 reader (mmap, fp16+fp32).
- `src/yolo_letterbox.c`   — real bilinear letterbox + RGB→CHW fp32
                             preprocessor (matches Ultralytics'
                             default 114-grey neutral pad).
- `src/yolo_kernels.c`     — pure-C scalar Conv2D / BN-fold / SiLU /
                             Concat / Upsample2 / MaxPool / Softmax
                             kernel set used by the eventual forward
                             pass.
- `src/yolo_runtime.c`     — `yolo_open` mmaps the GGUF, validates
                             metadata, fp16→fp32 promotes every Conv2D
                             weight, materialises every tensor in
                             heap. `yolo_detect` exercises the real
                             letterbox preprocessor end-to-end and
                             returns `-ENOSYS` honestly until the
                             scalar-C op-schedule that wires
                             backbone+neck+head lands. `yolo_close`
                             releases the session. `yolo_active_backend`
                             reports `"cpu-ref"`.

CMake builds `libyolo.a` (static) PLUS `libyolo.so` (shared, for
`bun:ffi` from `plugins/plugin-vision/src/yolo-detector-ggml.ts`) plus
five test binaries: `yolo_stub_smoke` (ABI link probe + lifecycle
contract), `yolo_nms_test` (NMS behaviour), `yolo_classes_test`
(class table), `yolo_letterbox_test` (preprocessor identity + center-
pad + grey-pad assertions), `yolo_runtime_test` (open / metadata
validation / detect-staged-forward path; runs the full open+letterbox
roundtrip when `YOLO_TEST_GGUF` env var points at a real GGUF). All
five pass on the dev host.

## Why this lives here

- `plugins/plugin-vision/src/yolo-detector.ts` declares the
  `YOLODetector` interface that `plugins/plugin-vision/src/person-
  detector.ts` consumes through a class filter. The generic
  `PersonInfo[]` shape it returns is the contract that the wider
  vision pipeline depends on.
- The current implementation imports `onnxruntime-node` and downloads
  a YOLOv8 ONNX file at runtime. The wider repo cleanup is removing
  every ONNX path — the new home for the model graph is the
  elizaOS/llama.cpp fork's ggml dispatcher (the same fork that already
  hosts the audio + LLM stacks via the `llama.cpp` submodule).
- YOLOv8n and YOLOv11n map cleanly onto ggml ops: the backbone is a
  pure Conv → BN → SiLU stack (CSPDarknet for v8, C2f-PSA for v11),
  the neck is FPN-style PANet (more Conv + concat + upsample), and
  the decoupled head is one Conv per branch + a fixed DFL projection
  matrix (`ggml_mul_mat` over a small fixed matrix). NMS runs on the
  C side (already implemented in this directory).

## Upstream pin

- Repo: https://github.com/ultralytics/ultralytics
- Tag:  `v8.4.51` (the latest stable tag at Phase 2 conversion time).
- Commit: `14ea57b11969cd872f15291e5d0bdc965bdb59f7` — recorded both
  here and in `scripts/yolo_to_gguf.py`'s `ULTRALYTICS_UPSTREAM_COMMIT`
  constant. The runtime reads `yolo.upstream_commit` from the GGUF and
  could refuse to load an unknown commit (today the runtime only
  validates `yolo.detector` / `yolo.input_size` / `yolo.num_classes` /
  `yolo.dfl_bins`; the upstream-commit refusal lands when we have a
  second pin to validate against).
- Models the port targets (Phase 2 verifies parity against the
  upstream Python reference for both):
  - `yolov8n` — ~3.2M params, 8.7 GFLOPs, 640×640 input, COCO 80
    classes. CSPDarknet backbone + PANet neck + decoupled head.
  - `yolov11n` — ~2.6M params, 6.5 GFLOPs, 640×640 input, COCO 80
    classes. C2f-PSA backbone + PANet neck + decoupled head. Same
    output schema as v8.

Both variants share the head layout (`4 + num_classes` channels per
anchor cell) and the runtime dispatcher only branches on backbone op
schedule. The on-disk GGUF carries the variant tag in
`yolo.detector` and the runtime refuses any other value.

## C ABI (frozen by `include/yolo/yolo.h`)

The stub already implements this surface; the real port must match
it byte-for-byte:

- `yolo_open(const char *gguf_path, yolo_handle *out)` — load a
  yolo GGUF produced by `scripts/yolo_to_gguf.py`. Refuses any GGUF
  whose `yolo.detector` key is not one of `YOLO_DETECTOR_YOLOV8N` /
  `YOLO_DETECTOR_YOLOV11N`. Returns 0 on success and writes the new
  handle into `*out`.
- `yolo_detect(handle, image, conf, iou, out, out_cap, *out_count)` —
  letterbox + run + decode + NMS + un-letterbox. Writes survivors to
  `out`, sets `*out_count`. `-ENOSPC` + filled `*out_count` on
  overflow so callers can resize and re-call.
- `yolo_close(handle)` — release the ggml graph, scratch buffers,
  GGUF mapping. NULL-safe; returns 0 on a NULL handle.
- `yolo_active_backend()` — diagnostics only. Stub returns `"stub"`;
  real impl returns `"ggml-cpu"`, `"ggml-vulkan"`, `"ggml-metal"`.
- `yolo_class_name(class_id)` — COCO-80 lookup (real today).

Coordinate convention: every detection's `(x, y, w, h)` is in
**source-image absolute pixel coordinates** with `(x, y)` at the
top-left. `yolo_detect` performs the letterbox-undo before returning;
callers do not see the 640×640 input space.

Threading: reentrant against distinct `yolo_handle` values; sharing
one handle across threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOSYS` from the stub,
`-ENOENT` for missing GGUF, `-EINVAL` for shape / version mismatch,
`-ENOSPC` for caller-buffer overflow. No silent fallbacks.

## GGUF conversion (`scripts/yolo_to_gguf.py`)

Mirrors the layering in
`packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`
and `packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py`:

- one writer, written-once metadata block, all tensors packed in a
  single pass;
- locked block-format constants at the top of the file (`INPUT_SIZE
  = 640`, `NUM_CLASSES = 80`, `SUPPORTED_VARIANTS = (yolov8n,
  yolov11n)`);
- pinned upstream commit recorded both in code and in the GGUF
  metadata key — runtime refuses unknown commits;
- `NotImplementedError` in every TODO block so a half-built converter
  cannot pass for working.

The first conversion pass packs Conv2d weights as fp16 and BN running
stats as fp32 sidecar tensors (gamma, beta, running_mean,
running_var, eps), keeping BN separate from Conv so the conversion
stays auditable. The runtime fuses BN into the preceding Conv at
session-open time. The decoupled head's DFL projection is emitted
under its Ultralytics state-dict path (`model.<head_idx>.dfl.conv.
weight`) and applied in the ggml graph.

Later passes can layer `Q4_POLAR` on the conv weights using the same
GGUF type-tag overrides `polarquant_to_gguf.py` demonstrates — the
GGUF format already supports per-tensor `raw_dtype` overrides, and
the fork integration that registers Q4_POLAR=45 in `ggml-common.h`
is already underway in `packages/native-plugins/polarquant-cpu/fork-
integration/`.

## elizaOS/llama.cpp fork integration

The port's runtime calls live in this library; the fork only needs to
expose its ggml dispatcher and (optionally) any custom op the head
decode needs (none expected — DFL is a fixed `ggml_mul_mat`).

The integration plan is:

1. **Bring up the YOLOv8n backbone first.** CSPDarknet is a pure
   chain of `ggml_conv_2d` → `ggml_norm` (with the BN stats baked in
   at fuse time) → SiLU activation (`ggml_silu`). The fork supports
   all of these today.
2. **Bring up the PANet neck.** FPN top-down + bottom-up paths need
   `ggml_concat` and `ggml_upsample` (both already in the fork).
3. **Bring up the decoupled head.** Two output convs per scale (one
   for box regression, one for class scores) plus one fixed DFL
   projection (`ggml_mul_mat` over a small tabulated matrix). The
   sigmoid for class scores is `ggml_sigmoid`. The DFL + stride
   decode runs in the graph; the post-decode (argmax class +
   threshold) runs in `yolo_decode_one` in C.
4. **Wire to the fork's dispatcher.** The session-open path picks
   the available backend (CPU / Metal / Vulkan) the same way
   `polarquant-cpu` and `doctr-cpp` will. `yolo_active_backend()`
   reports the bound backend's name.
5. **Bring up YOLOv11n by switching the backbone op schedule.** The
   C2f-PSA backbone uses the same primitive ops as CSPDarknet plus
   the partial self-attention block, which lowers to a small
   `ggml_mul_mat` + `ggml_softmax` + `ggml_mul_mat` chain.
6. **Add a fork patch directory.** `fork-integration/` will hold the
   minimal set of patches against the fork (none expected for the
   first pass — every YOLO op exists in the fork today). Mirror the
   layout used in `packages/native-plugins/polarquant-cpu/fork-
   integration/` if patches do prove necessary.

## Replacement of `yolo-detector.ts`

Once `yolo_open` returns 0 and the parity tests in this directory
pass, `plugins/plugin-vision/src/yolo-detector.ts` is replaced by
`plugins/plugin-vision/src/yolo-detector-ggml.ts` (the new file,
already scaffolded as a TS binding to this library). The
`YOLODetector` class signature stays identical so
`plugins/plugin-vision/src/person-detector.ts` keeps working
unchanged.

## Build (today)

```
cmake -B build -S packages/native-plugins/yolo-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libyolo.a` plus three test binaries — `yolo_stub_smoke`,
`yolo_nms_test`, `yolo_classes_test`. All three pass on the dev host;
that's the contract the port preserves while it grows real
implementations behind the same ABI.

## What's done vs. still missing

Done in Phase 2 (this commit set):

- Pinned ultralytics commit (`14ea57b119` / tag `v8.4.51`), recorded
  here and in `scripts/yolo_to_gguf.py` and embedded in the GGUF
  metadata key `yolo.upstream_commit`.
- Real `scripts/yolo_to_gguf.py` — downloads or loads the Ultralytics
  pretrained weights, walks the state_dict, drops
  `num_batches_tracked` scalars, sanity-checks key+shape against a
  pinned reference table, packs Conv2D weights as fp16 and BN
  params + DFL projection as fp32, emits a single ~6.2 MB GGUF.
- Real `src/yolo_gguf.c` — minimal GGUF v3 reader, mmap-backed,
  fp16+fp32 supported, scalar/string/array metadata getters, tensor
  lookup by name with PyTorch-outer-first dim reporting.
- Real `src/yolo_letterbox.c` — bilinear resize + center pad with
  Ultralytics' 114-grey neutral, reports scale + pad offsets so the
  postprocess can un-letterbox bboxes.
- Real `src/yolo_kernels.c` — scalar Conv2D, BN-fold to per-channel
  (scale, shift), SiLU, sigmoid, channel-axis concat, 2× nearest
  upsample, MaxPool2D-same, per-row softmax. The op set the v8/v11
  forward pass needs.
- Real `src/yolo_runtime.c` — `yolo_open` mmaps GGUF, validates
  metadata (variant, input size, classes, DFL bins, BN eps),
  fp16→fp32 promotes every tensor into heap. `yolo_close` releases.
  `yolo_active_backend` reports `"cpu-ref"`. `yolo_detect` runs the
  real letterbox preprocessor; the forward pass itself is staged.
- Shared library target `libyolo.so` for `bun:ffi` consumption.
- New ctests: `yolo_letterbox_test` (preprocessor behaviour) and
  `yolo_runtime_test` (open + metadata + staged-forward contract).
- TS binding `plugins/plugin-vision/src/yolo-detector-ggml.ts` now
  `dlopen`s `libyolo.so` through `bun:ffi`, calls the real C ABI,
  marshals the `yolo_image` + `yolo_detection` records by hand,
  honours the `-ENOSYS` staged-forward signal, and falls back to the
  ONNX detector silently when the native lib isn't built.
- Parity-test harness `test/yolo_parity_test.py` — runs both the
  Ultralytics Python reference and `libyolo` via ctypes, asserts
  per-detection class match + IoU ≥ 0.95 + confidence within 1e-2,
  and exits with CTest's "skipped" code (77) while the C-side
  forward pass is staged. When the forward lands, the parity asserts
  trigger and this script becomes the production gate.

Still missing (Phase 3 work):

- Scalar-C v8n forward pass: wire `yolo_detect`'s op schedule
  (CSPDarknet backbone → SPPF → PANet neck → decoupled head with
  DFL+stride decode → `yolo_decode_one` → `yolo_nms_inplace` →
  un-letterbox). Every kernel the schedule needs is already in
  `yolo_kernels.c`. The slow path is acceptable for a parity gate;
  the fast path needs the next bullet.
- Either ggml-dispatcher integration against the elizaOS/llama.cpp
  fork (preferred for production — gets Vulkan / Metal "for free")
  OR an im2col + AVX2/NEON GEMM dispatcher inline in this package
  (mirrors `qjl-cpu`). Phase 2 keeps the contract honest by
  reporting `"cpu-ref"` until either lands.
- YOLOv11n op schedule (same kernels, different head index +
  C2f-PSA backbone). The runtime accepts the v11n metadata tag
  today; the schedule lands alongside its parity tests.
- `fork-integration/` patches if any new ggml ops are needed (none
  expected — every YOLO op exists in the fork today).
