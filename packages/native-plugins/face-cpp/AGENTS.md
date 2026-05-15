# face-cpp — port plan

Standalone C library that ports two ONNX-backed face stages out of
`plugins/plugin-vision` and onto the elizaOS/llama.cpp fork's ggml
dispatcher:

1. **BlazeFace** (front model, 128x128) — replaces
   `face-detector-mediapipe.ts` (which uses `onnxruntime-node`).
2. **128-d face embedding** (FaceNet-style or ArcFace-mini / buffalo_s
   MobileFaceNet) — replaces `face-recognition.ts` (which uses
   `face-api.js`, itself layered on TensorFlow.js / ONNX).

Both heads share a single C ABI (`include/face/face.h`) and load from
GGUF artifacts produced by the converter scripts in `scripts/`.

This document is the contract the port must satisfy. Today the
library is a **stub for the model entries** plus **real
implementations for the model-independent helpers** (anchor table,
anchor decode, 5-point alignment + bilinear sampler, cosine / L2
embedding distance). The real port plan replaces `src/face_stub.c`
without changing the ABI.

## Why this lives here

- `plugins/plugin-vision/src/face-detector-mediapipe.ts` runs
  BlazeFace through `onnxruntime-node`; the eliza-1 inference fabric
  already dispatches local vision work through the elizaOS/llama.cpp
  fork, and BlazeFace should too.
- `plugins/plugin-vision/src/face-recognition.ts` runs face-api.js
  end-to-end, which pulls TensorFlow.js + ONNX into the runtime. The
  contract we actually need from it is "give me a 128-d embedding for
  this face crop"; everything else (`ssdMobilenetv1`,
  `faceLandmark68Net`, `ageGenderNet`, `faceExpressionNet`) is a
  product surface we either don't ship or can recover from cheaper
  signals.
- A single native library per surface keeps both stages on the same
  GGUF + ggml dispatcher path the `qjl-cpu`, `doctr-cpp`, and
  `yolo-cpp` siblings already use.

## Upstream pins

- BlazeFace front model
  - Repo: https://github.com/google/mediapipe
  - Canonical weights:
    `mediapipe/modules/face_detection/face_detection_front.tflite`
  - Python ports we'll address weights against:
    https://github.com/hollance/BlazeFace-PyTorch
  - Commit: **TODO — pin at conversion time and record in
    `face.upstream_commit` (see `scripts/blazeface_to_gguf.py`).**

- Face embedding network (pick one per build)
  - `arcface_mini_128`:
    https://github.com/deepinsight/insightface — `buffalo_s` pack.
    Backbone: MobileFaceNet (`w600k_mbf.onnx`). Trained on MS1M-V3,
    L2-normalized 128-d output, ~5 MB at fp16.
  - `facenet_128`:
    https://github.com/timesler/facenet-pytorch — InceptionResnetV1
    re-headed to 128-d output. Larger (~25 MB at fp16) but available
    in PyTorch out of the box.

## C ABI (frozen by `include/face/face.h`)

The header declares two opaque handles (`face_detect_handle`,
`face_embed_handle`) plus three groups of entry points. The stub
already implements the ABI; the real port must match it byte-for-byte.

### Detection
- `face_detect_open(gguf_path, *out)` — load a BlazeFace GGUF.
  Refuses GGUFs whose `face.detector` key is not
  `FACE_DETECTOR_BLAZEFACE_FRONT`.
- `face_detect(handle, rgb, w, h, stride, conf, out, cap, *count)` —
  run inference + post-process. Wraps the model forward, the anchor
  decode (`face_blazeface_decode`), and IoU-NMS.
- `face_detect_close(handle)`.

### Recognition
- `face_embed_open(gguf_path, *out)` — load an embedding GGUF.
  Refuses GGUFs whose `face.embedder` key is not in the supported set
  (`FACE_EMBEDDER_FACENET_128`, `FACE_EMBEDDER_ARCFACE_MINI_128`).
- `face_embed(handle, rgb, w, h, stride, *crop, *embedding_out)` —
  align the face via `face_align_5pt`, normalize per the embedder's
  preprocessor, run forward, and L2-normalize the 128-d output.
- `face_embed_close(handle)`.
- `face_embed_distance(*a, *b)` — cosine distance between two
  unit-norm 128-d embeddings. Real (not stubbed) helper.
- `face_embed_distance_l2(*a, *b)` — L2 distance counterpart.

### Anchors (real today)
- `face_blazeface_make_anchors(out, cap)` — generate the 896-anchor
  table for the locked stride/per-cell schedule (8/2 + 16/6 on a
  128×128 input).
- `face_blazeface_decode(anchors, regressors, scores, conf, src_w,
  src_h, out, cap, *count)` — decode raw model outputs into
  source-pixel detections (no NMS).

### Alignment (real today)
- `face_align_5pt(rgb, src_w, src_h, src_stride, *det, *out_rgb)` —
  similarity-warp the face crop into a 112×112 RGB image keyed on the
  5 alignment keypoints (eyes, nose, mouth corners). Pure C bilinear
  sampler.

### Diagnostics
- `face_active_backend()` — `"stub"` today, `"ggml-cpu"` /
  `"ggml-metal"` / etc. once the model TUs land.

Coordinate convention: every bbox is `{x, y, w, h}` in source-image
absolute pixel coordinates (`(x, y)` is top-left). Landmarks are
packed as 6 (x, y) pairs in BlazeFace order:
left-eye, right-eye, nose-tip, mouth-centre, left-ear, right-ear.

Threading: reentrant against distinct handles; sharing one across
threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOSYS` from the stub model
entries, `-ENOENT` for missing GGUF, `-EINVAL` for shape mismatch /
degenerate input, `-ENOSPC` for caller-buffer overflow. No silent
fallbacks.

## GGUF conversion

Two scripts, mirroring the layering in
`packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py` and
`packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`:

- `scripts/blazeface_to_gguf.py` — single-pass fp16 conversion of the
  BlazeFace front model. Writes:
  - `face.detector`            = `"blazeface_front"`
  - `face.detector_input_size` = `128`
  - `face.anchor_count`        = `896`
  - `face.anchor_strides`      = `[8, 16]`
  - `face.anchor_per_cell`     = `[2, 6]`
  - `face.upstream_commit`     = TODO (pin at conversion time)
- `scripts/face_embed_to_gguf.py` — fp16 conversion of either
  `arcface_mini_128` (buffalo_s MobileFaceNet) or `facenet_128`
  (InceptionResnetV1). Writes:
  - `face.embedder`            = one of `FACE_EMBEDDER_*`
  - `face.embedder_input_size` = `112`
  - `face.embedder_dim`        = `128`
  - `face.upstream_commit`     = TODO (pin at conversion time)

Both scripts ship `NotImplementedError` in every TODO block so a
half-built converter cannot pass for working.

## elizaOS/llama.cpp fork integration

The port's runtime calls live in this library; the fork only needs to
expose its ggml dispatcher and the standard 2-D conv / norm / activation
ops both heads use. The integration plan:

1. **Bring up BlazeFace first.** Architecture is a small
   BlazeBlock-based feature extractor (depthwise + pointwise convs)
   plus per-stride classification and regression heads. All ops are
   already available in the fork (`ggml_conv_2d`, `ggml_norm`,
   ReLU/PReLU). Anchor decode (`face_anchor_decode.c`) is already done
   and tested; the model entry just needs to call it after the
   forward pass and run IoU-NMS on the result.
2. **Bring up the embedder next.** Both supported families are
   convolutional (MobileFaceNet for arcface_mini_128;
   InceptionResnetV1 for facenet_128). The 5-point affine warp
   (`face_align.c`) is already done and tested; the model entry just
   needs to call it before the forward pass and L2-normalize the 128-d
   output.
3. **Wire to the fork's dispatcher.** Expose a
   `face_set_ggml_backend(backend)` setter (mirroring
   `polarquant-cpu`'s registration path). The stub already advertises
   `face_active_backend()`; the real impl reports the bound backend's
   name.
4. **Add a fork patch directory if needed.** None expected for the
   first pass — both models use stock ops.

## Replacement of `face-detector-mediapipe.ts` and `face-recognition.ts`

Once `face_detect_open` returns 0 and the new TS bindings
(`plugins/plugin-vision/src/face-detector-ggml.ts` and
`face-recognition-ggml.ts`) pass parity against the existing detectors
on a fixture set, the plumbing in `face-recognition.ts` /
`face-detector-mediapipe.ts` gets retired. The `setFaceBackend()`
toggle stays, with `"ggml"` becoming the default and the legacy
backends kept behind feature flags only as long as the embeddings
they produced are still in user face libraries (re-embedding migration
is required because cosine distance between facenet-pytorch and
arcface_mini_128 embeddings is not meaningful).

## Build (today)

```
cmake -B build -S packages/native-plugins/face-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libface.a` plus four test binaries:
- `face_stub_smoke`    — model-entry ABI returns `-ENOSYS`.
- `face_anchor_test`   — anchor table + decode behaviour.
- `face_align_test`    — 5-point similarity warp + bilinear sampler.
- `face_distance_test` — cosine + L2 distance on unit-norm vectors.

All four pass on the dev host today.

## What's missing before the port is real

- Pinned `google/mediapipe` commit + recorded BlazeFace weights
  download recipe.
- Pinned upstream commit + recorded weights download recipe for the
  chosen embedder family.
- `discover_blazeface_tensors`, `discover_embedder_tensors`,
  `write_gguf` implementations in the two converter scripts (TODO
  blocks call out the exact work).
- Real `face_detect_open` / `face_detect` / `face_embed_open` /
  `face_embed` translation units that drive the ggml dispatcher.
- IoU-NMS implementation (called by `face_detect` after
  `face_blazeface_decode`).
- Parity test: ingest a small set of real face crops, run both the
  Python reference (`onnxruntime` BlazeFace + insightface buffalo_s)
  and this library, assert per-bbox IoU ≥ 0.95 and per-pair embedding
  cosine distance ≤ 0.05.
- `fork-integration/` patches if any new ggml ops are needed (none
  expected for the first pass).
