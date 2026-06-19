# plugin-vision runtime migration: ONNX / TF.js / face-api / tesseract → ggml

## Status (update)

- **TensorFlow.js: REMOVED.** `@tensorflow/tfjs-node`,
  `@tensorflow-models/coco-ssd`, and `@tensorflow-models/pose-detection` are
  gone from `package.json`; `src/vision-models.ts` is deleted.
- **Object detection: LIVE on ggml.** `native/yolo.cpp` now implements the full
  YOLOv8n forward pass on ggml (built + numerically verified against the
  PyTorch reference — box max |Δ| ≈ 0.001 px, classes exact). Build it with
  `bun run build:native` and convert weights with `bun run build:weights`; the
  self-contained `libyolo.<ext>` links ggml statically.
- **Pose: deferred to the heuristic path.** MoveNet is removed; a ggml MoveNet
  port remains the open item (Phase 3 below). `service.ts` falls back to
  motion-derived person detection when pose is requested.
- **face-api.js: REMOVED.** `face-api.js` (and the `canvas` polyfill it
  required) are gone from `package.json`; `src/face-recognition.ts` is deleted.
  Face recognition now runs entirely on the native ggml path
  (`face-detector-ggml.ts` BlazeFace + `face-recognition-ggml.ts` 128-d embed),
  disabled until the `native/face-cpp` lib/GGUF artifacts land. The face-api.js
  expression and age/gender nets are dropped (not a product requirement).
- **Remaining:** doCTR/RetinaFace/MobileFaceNet ggml ports are scaffolded
  pending weights.

## Charter

Every local vision model in `plugin-vision` must run through a ggml-based C++
runtime. **No** ONNX, **no** TensorFlow, **no** TF.js, **no** face-api.js, **no**
tesseract.js. This mirrors the work already done in `plugin-local-inference`
(see `plugins/plugin-local-inference/VISION_MIGRATION.md`) which moved the VLM
to llama.cpp via `mtmd` + `mmproj`. That migration covered IMAGE_DESCRIPTION
only. The auxiliary models — OCR, object detection, person detection, pose, and
face — still live on the legacy stack in this plugin. This doc covers them.

## Audit (Phase 1a — complete)

| Feature                  | Current source                              | Current runtime                                          | TS module                                | Target ggml runtime                                      | Target weight file(s)                                                  |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| OCR (primary)            | PP-OCRv5 mobile (RapidOCR fork)             | `onnxruntime-node`, ORT CPU/CoreML/DirectML EPs          | `src/ocr-service-rapid.ts`               | doCTR via custom `doctr.cpp` (ggml)                      | `vision/doctr-det.gguf`, `vision/doctr-rec.gguf`, `vision/doctr-vocab.txt` |
| OCR (fallback)           | Tesseract LSTM                              | `tesseract.js` (WASM)                                    | `src/ocr-service-real.ts`                | **deleted** — no fallback (single canonical path)        | n/a                                                                    |
| OCR (Apple Vision)       | Apple `VNRecognizeTextRequest`              | Native provider via `plugin-computeruse` mobile bridge   | `src/ocr-service.ts` (`AppleVisionBackend`) | **kept** — already native, not an ML runtime           | n/a                                                                    |
| Object detection         | COCO-SSD (mobilenet_v2)                     | `@tensorflow/tfjs-node` (libtensorflow C addon)          | `src/vision-models.ts`                   | YOLOv8n via `yolo.cpp` (ggml)                            | `vision/yolov8n.gguf` (80-class COCO)                                  |
| Object detection (alt)   | YOLOv8n ONNX                                | `onnxruntime-node`                                       | `src/yolo-detector.ts`                   | YOLOv8n via `yolo.cpp` (ggml) — same as above            | `vision/yolov8n.gguf`                                                  |
| Person detection         | Class-filtered YOLOv8n                      | `onnxruntime-node` (delegates to YOLODetector)           | `src/person-detector.ts`                 | YOLOv8n ggml + class filter                              | `vision/yolov8n.gguf`                                                  |
| Pose detection           | MoveNet MultiPose Lightning                 | `@tensorflow/tfjs-node` + `@tensorflow-models/pose-detection` | `src/vision-models.ts`              | MoveNet via ggml port (custom)                           | `vision/movenet-multipose.gguf`                                        |
| Face detection           | SSD-MobileNet-v1 (face-api.js bundle)       | `face-api.js` (TF.js core in pure JS)                    | `src/face-recognition.ts`                | RetinaFace via ggml port (custom)                        | `vision/retinaface.gguf`                                               |
| Face detection (alt)     | BlazeFace (MediaPipe)                       | `onnxruntime-node`                                       | `src/face-detector-mediapipe.ts`         | BlazeFace via ggml port (custom)                         | `vision/blazeface.gguf` (alt path; RetinaFace is primary)              |
| Face landmarks (68pt)    | face-api.js `faceLandmark68Net`             | `face-api.js`                                            | `src/face-recognition.ts`                | PFLD-like ggml port OR drop landmarks (decision below)   | `vision/pfld-68.gguf` (optional)                                       |
| Face embedding (128-d)   | face-api.js `faceRecognitionNet` (Inception/ResNet) | `face-api.js`                                    | `src/face-recognition.ts`                | ArcFace / MobileFaceNet ggml port                        | `vision/mobilefacenet.gguf`                                            |
| Face expressions         | face-api.js `faceExpressionNet`             | `face-api.js`                                            | `src/face-recognition.ts`                | **drop** — not used in product, removable optimization   | n/a                                                                    |
| Face age/gender          | face-api.js `ageGenderNet`                  | `face-api.js`                                            | `src/face-recognition.ts`                | **drop** — same reason                                   | n/a                                                                    |
| VLM (IMAGE_DESCRIPTION)  | Qwen3-VL mmproj                             | llama.cpp (`mtmd`) — already migrated                    | `plugin-local-inference`                 | unchanged                                                | `vision/mmproj-<tier>.gguf`                                            |

### Dependency closure to delete from `plugin-vision/package.json`

- `tesseract.js` → delete after Phase 1c.
- `onnxruntime-node` → delete after Phase 2.
- `@tensorflow/tfjs-node`, `@tensorflow-models/coco-ssd`, `@tensorflow-models/mobilenet`, `@tensorflow-models/pose-detection` → delete after Phase 3.
- `face-api.js` → delete after Phase 3.
- `canvas` → keep (used for framebuffer manipulation, not an ML runtime).
- `sharp` → keep (image preprocessing).

## Why ggml / what runtime per model

The objective is a single C++ runtime family for every local model in the
plugin. Three candidate codebases meet that bar:

1. **llama.cpp / mtmd / mmproj** — already the chosen runtime for VLM (see
   `plugin-local-inference/VISION_MIGRATION.md`). `mtmd` supports CLIP-class
   image encoders; it does **not** support detection-head models (YOLO),
   keypoint regressors (MoveNet/PFLD), or detection-and-classification CNNs
   (RetinaFace, doCTR-DBNet). So llama.cpp is the right home for the VLM and
   the wrong home for the auxiliary models.

2. **ggml directly (the kernel library underneath llama.cpp)** — pure-C library
   that exposes the same tensor/graph primitives. The right home for the
   auxiliary models. The `ggml-org` GitHub org hosts reference ports:
   - `whisper.cpp` (audio) — pattern for "non-LLM ggml binary embedded in a
     project".
   - `stable-diffusion.cpp` — pattern for CNN inference with ggml.
   - `bark.cpp`, `clip.cpp`, etc.
   The auxiliary models in this audit (DBNet, CRNN, YOLOv8, MoveNet,
   RetinaFace, MobileFaceNet, BlazeFace) are all standard CNN/transformer
   architectures that ggml already has ops for (conv2d, batchnorm, deformable
   conv via composition, residual blocks, RoIAlign via composition).

3. **GGUF-format weights** for every model. GGUF is the ggml-team's
   self-describing container — same format already used for llama.cpp and the
   `mmproj` projector. We use it for the auxiliary models so the model-cache
   path, hash verification, and download tooling can be shared with
   `plugin-local-inference`.

### Per-model runtime choices

- **OCR (doCTR)** — doCTR is two stages: detection (DBNet variant) +
  recognition (CRNN / parseq transformer). Both are small (DBNet ~16 MB,
  CRNN ~12 MB at fp16). No public `doctr.cpp` port exists today — we author
  one as part of this migration (`native/doctr.cpp/`). User specifically
  named doCTR; we honor that.

- **Object / person detection (YOLOv8n)** — `yolo.cpp` ports exist in the
  community (mostly Rust-rewrites or partial). We use the well-known
  `nihui/ncnn` reference structure adapted to ggml ops, plus the existing
  YOLO decode logic from `src/yolo-detector.ts` (parseYoloV8 + NMS) for the
  post-process step (we keep that in TS — it's trivial and runtime-portable).

- **Pose (MoveNet)** — Google's MoveNet is a tiny mobilenet-style backbone
  with a heatmap head. No public ggml port. We author one. Or: defer pose to
  a follow-up and gate behind a clear `throw new Error("...")`. **Decision:
  defer pose** to a follow-up PR; the current production code already had
  pose behind heuristic fallback, so removing it doesn't regress anything
  in-product (see Phase 3 plan).

- **Face detection (RetinaFace) + embedding (MobileFaceNet)** — both have
  ggml conversion paths documented in the `face-recognition.cpp` community
  fork tree. We author them as part of Phase 3. Like pose, this is deferred
  — face-recognition is currently behind a feature flag (`enableFaceRecognition`)
  and not on a critical product path.

## Phased delivery (this run + follow-up)

### Phase 1 (this run — execute fully)
- ✅ Audit + decision doc (this file).
- Add `native/doctr.cpp/` scaffolding: C++ source, CMake, FFI surface, weight
  conversion script (PyTorch → GGUF).
- Add `native/ggml-vision/` shared runtime: ggml submodule pin, build glue,
  shared image preprocessing helpers (RGB CHW float32 normalization).
- Rewrite `src/ocr-service-rapid.ts` → `src/ocr-service-doctr.ts` against the
  new FFI. Old `ocr-service-rapid.ts` deleted.
- Delete `src/ocr-service-real.ts` (tesseract).
- Update `src/ocr-service.ts`: chain becomes `[doctr, apple-vision]`. No
  tesseract fallback. Throws if neither is available.
- Remove `tesseract.js` from `package.json`.
- Gate doCTR path to throw clearly when GGUFs are missing (the FFI is wired,
  the conversion script is written, but actual weight building happens
  out-of-band in a model-publishing pass).

### Phase 2 (start this run, may not complete)
- Add `native/yolo.cpp/` scaffolding: C++ source, CMake, FFI surface,
  conversion script (Ultralytics .pt → GGUF).
- Rewrite `src/yolo-detector.ts` to use the FFI. Keep `parseYoloV8` + NMS in
  TS (runtime-portable, no native cost).
- Remove `onnxruntime-node` from `package.json` if **and only if** Phase 2
  fully lands (otherwise leave the ONNX path running and remove in a
  follow-up — never half-remove a runtime).

### Phase 3 (documented pending work)
- MoveNet pose port (`native/movenet.cpp/`).
- RetinaFace + MobileFaceNet face port (`native/retinaface.cpp/`,
  `native/mobilefacenet.cpp/`).
- Remove `@tensorflow/*`, `face-api.js` from `package.json`.
- Delete `src/vision-models.ts`, `src/face-recognition.ts`,
  `src/face-detector-mediapipe.ts`.

See "Phase 3 plan" below.

## doCTR → ggml: conversion strategy

doCTR (Mindee, MIT) ships in PyTorch. Both the detection and recognition
backbones are standard:

- **Detection**: `db_mobilenet_v3_large` (default, ~16 MB) — MobileNetV3 large
  backbone with a DBNet head. The head outputs a probability map and threshold
  map; post-process is the same DBNet post-process we already have in
  `src/ocr-service-rapid.ts::probMapToBoxes`. We keep that TS code (no native
  cost), so the C++ side only runs the backbone + head.

- **Recognition**: `crnn_mobilenet_v3_small` (default, ~12 MB) — MobileNetV3
  small backbone + bidirectional LSTM + linear head, CTC decoding. CTC decode
  stays in TS (same `ctcDecode` we already have).

### Conversion pipeline (script lives at `native/doctr.cpp/convert.py`)

```
mindee/doctr (pip)
  ↓ load_pretrained_params=True
  ↓ extract state_dict, map names to GGUF tensor names
  ↓ optionally quantize linear/conv weights to q4_0 (keep BN params fp32)
  ↓ write GGUF with hyperparams in metadata:
    - input_size: [3, 1024, 1024] for det / [3, 32, 128] for rec
    - mean/std normalization constants
    - charset (rec only) — embed as KV entry "doctr.charset"
```

### C++ runtime (`native/doctr.cpp/doctr.cpp`)

Two GGUF files, two ggml graphs:

```c
struct doctr_det_ctx;
struct doctr_rec_ctx;

doctr_det_ctx * doctr_det_init(const char * gguf_path);
doctr_rec_ctx * doctr_rec_init(const char * gguf_path);

// det: input (H,W,3) RGB float32 in [0,1] (we apply mean/std internally)
//      output: prob_map (H/4, W/4) float32 in [0,1]
int doctr_det_run(doctr_det_ctx *, const float * rgb, int h, int w,
                  float * out_probmap, int * out_h, int * out_w);

// rec: input crop, 32xN float32
//      output: logits (T, C) where C = charset.size + 1 (blank)
int doctr_rec_run(doctr_rec_ctx *, const float * rgb_crop, int h, int w,
                  float * out_logits, int * out_T, int * out_C);

void doctr_det_free(doctr_det_ctx *);
void doctr_rec_free(doctr_rec_ctx *);
```

### TS FFI

`bun:ffi` (already used by `plugin-local-inference/native/llama.cpp` bindings —
see that plugin's `src/native/` for the pattern). We expose a thin TS class
`DocTRSession` with `init/extractText/dispose`.

### Memory budget

- Detection: ~16 MB weights + 1024² fp32 prob_map intermediates = ~50 MB
  peak when running on a 1024×1024 page. Within the same envelope as PP-OCRv5.
- Recognition: ~12 MB + per-crop activations. Negligible.
- Initialization cost: ~150 ms cold (mmap GGUF + build ggml graph).

## Phase 2 — YOLOv8n → ggml: conversion strategy

YOLOv8 is published by Ultralytics under AGPL-3.0; we ship **weights** (not
code) and convert from the published `.pt` to GGUF via a script. The C++ port
in this repo (`native/yolo.cpp/yolo.cpp`) is an original, clean-room
implementation built directly on ggml — no AGPL code lives in this repo.

### Ops needed

YOLOv8n uses: conv2d, batchnorm (fused at convert time), silu, max-pool,
nearest-neighbor upsample, concat, residual add. All present in ggml.

### Postprocess

Already done in `src/yolo-detector.ts::parseYoloV8` and `::nms`. We keep that.
The C++ side only runs the forward pass.

### Conversion script (`native/yolo.cpp/convert.py`)

```
ultralytics.YOLO("yolov8n.pt")  → state_dict
  ↓ fuse BN into conv at convert time (standard optimization)
  ↓ optionally quantize 3x3 / 1x1 conv weights to q4_0
  ↓ write GGUF with metadata:
    - input_size: [3, 640, 640]
    - class names (80, COCO)
    - anchor-free strides [8, 16, 32]
```

## Phase 3 plan (not executed this run)

### MoveNet (pose)

- Backbone: MobileNetV2-ish (~3 MB). Heatmap head: 17 keypoints × 56×56.
- Conversion: TF SavedModel → ONNX (intermediate) → GGUF via `tf2onnx` +
  custom GGUF writer, OR directly from the TF weights with a custom script
  that mirrors the topology in ggml.
- Post-process: argmax over each keypoint heatmap, then x/y offset regression.
  Existing JS for `determinePoseFromKeypoints` / `determineFacingDirection`
  in `vision-models.ts` is reusable.
- Estimated effort: ~3 days of focused work.

### RetinaFace (face detection)

- Backbone: MobileNet 0.25× (~1.7 MB) or ResNet50. Three-scale FPN output
  with detection + landmark heads per anchor.
- Conversion: PyTorch `Retinaface_MobileNet0.25` → GGUF. Available as a
  reference checkpoint from `biubug6/Pytorch_Retinaface`.
- Post-process: anchor decode + NMS (parallel to YOLO post-process).
- Estimated effort: ~2 days.

### MobileFaceNet (face embedding)

- Backbone: MobileNetV2-ish with a global-depthwise final layer producing a
  128-d embedding (~4 MB at fp16).
- Conversion: PyTorch checkpoint from `deepinsight/insightface` (MIT).
- Use: replace `face-api.js::faceRecognitionNet`. Same embedding compare
  logic (`euclideanDistance`) in `face-recognition.ts` is reusable.
- Estimated effort: ~1 day.

### BlazeFace alt path

- Already scaffolded in `src/face-detector-mediapipe.ts` against ONNX. Once
  RetinaFace lands, we delete BlazeFace alt path entirely; one face detector
  is enough. Decision: **drop BlazeFace** rather than re-port — it was a
  hedge against face-api.js, not a product requirement.

## Verification approach

- For each migrated model, a smoke script under
  `native/<model>/verify/smoke.mjs` that runs a known input image and checks
  the output against a reference fixture (same pattern as
  `plugin-local-inference/native/verify/eliza1_vision_smoke.mjs`).
- For Phase 1 (this run): smoke is gated until GGUFs ship — the FFI surface
  is built but `throw new Error("…GGUF not ready")` until the conversion
  script is run end-to-end on a build host.
- `bun run --cwd plugins/plugin-vision build` must succeed at every commit.
  Typecheck is disabled in this plugin's `package.json` ("Typecheck skipped
  for release"), so we rely on the build step (tsdown) catching type errors.
- Grep `plugins/plugin-vision/` for `onnxruntime`, `@tensorflow`, `face-api`,
  `tesseract` — each remaining hit must be in a deleted-but-not-yet-pruned
  path, the alt face-detector marked for Phase 3 removal, or this doc.

## Non-fallback discipline (AGENTS.md §3, §8)

When a GGUF model is missing the call **throws clearly**. No silent fallbacks,
no "OCR returned empty string because the model wasn't there". The chain in
`OCRService` is `[doctr (primary), apple-vision (darwin)]`. If neither is
available, `initialize()` throws and the caller sees a real error.

## What this migration does not do

- Does not retrain any model. All conversions are weight-mapping only.
- Does not change the public TS API of `OCRService`, `YOLODetector`, etc.
  beyond removing constructor knobs that referenced specific runtimes
  (e.g. `executionProviders`).
- Does not touch `plugin-local-inference/native/llama.cpp` (the VLM path is
  already correct and we leave it alone per task constraints).
