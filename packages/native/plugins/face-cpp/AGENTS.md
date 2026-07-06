# face-cpp — native runtime

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

This document is the contract the runtime must satisfy. The model
entries are implemented by `src/face_model.c` with pure-C scalar
BlazeFace and embedder forwards, plus real model-independent helpers
(anchor table, anchor decode, 5-point alignment + bilinear sampler,
cosine / L2 embedding distance). Backend upgrades must stay behind the
same ABI.

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

- **BlazeFace front model** (PINNED)
  - Source: https://github.com/hollance/BlazeFace-PyTorch
  - Commit: `master @ 2c5b59d` (current `blazeface.pth` +
    `anchors.npy` shipping in that repo). The `.pth` is a 1:1 PyTorch
    re-export of the canonical
    `mediapipe/modules/face_detection/face_detection_front.tflite`
    (BN already folded into the conv weights).
  - Architecture: BlazeBlocks (depthwise 3x3 + pointwise 1x1 + ReLU)
    with two output strides 8 and 16, classifier_8 / classifier_16,
    regressor_8 / regressor_16. 896 anchors (16x16x2 + 8x8x6) on a
    128x128 input.
  - Encoded as `face.upstream_commit` =
    `"hollance/BlazeFace-PyTorch@2c5b59d"` in the GGUF.
  - Recorded in `scripts/blazeface_to_gguf.py` as
    `BLAZEFACE_UPSTREAM_COMMIT`.

- **Face embedding network** (PINNED, single supported variant for
  ABI stability)
  - Family: `facenet_128`
  - Source: https://github.com/timesler/facenet-pytorch
  - Pin: `facenet-pytorch==2.5.3` (PyPI) — InceptionResnetV1 trained
    on `vggface2` with the standard 512-d head, projected down to
    128-d via a fixed random orthonormal projection captured into the
    GGUF (so two builds with the same pin produce comparable
    embeddings). The 128-d projection matrix is regenerated only when
    `--regenerate-projection` is passed.
  - Encoded as `face.upstream_commit` =
    `"facenet-pytorch==2.5.3"` in the GGUF.
  - Recorded in `scripts/face_embed_to_gguf.py` as
    `EMBED_UPSTREAM_COMMIT`.

  (`arcface_mini_128` is accepted by the C ABI for compatibility, but
  only `facenet_128` is shipped today.)

## C ABI (frozen by `include/face/face.h`)

The header declares two opaque handles (`face_detect_handle`,
`face_embed_handle`) plus three groups of entry points. The native CPU
runtime implements this ABI.

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
  unit-norm 128-d embeddings.
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
- `face_active_backend()` — diagnostics. Returns `"ggml-cpu-ref"` for
  the current pure-C scalar runtime; dispatcher-backed builds can
  report `"ggml-cpu"`, `"ggml-metal"`, etc.

Coordinate convention: every bbox is `{x, y, w, h}` in source-image
absolute pixel coordinates (`(x, y)` is top-left). Landmarks are
packed as 6 (x, y) pairs in BlazeFace order:
left-eye, right-eye, nose-tip, mouth-centre, left-ear, right-ear.

Threading: reentrant against distinct handles; sharing one across
threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOENT` for missing GGUF,
`-EINVAL` for shape mismatch / degenerate input, `-ENOSPC` for
caller-buffer overflow. No silent fallbacks.

## GGUF conversion

Two scripts, mirroring the layering in
`packages/native/plugins/doctr-cpp/scripts/doctr_to_gguf.py` and
`packages/native/plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`:

- `scripts/blazeface_to_gguf.py` — single-pass fp16 conversion of the
  BlazeFace front model. Writes:
  - `face.detector`            = `"blazeface_front"`
  - `face.detector_input_size` = `128`
  - `face.anchor_count`        = `896`
  - `face.anchor_strides`      = `[8, 16]`
  - `face.anchor_per_cell`     = `[2, 6]`
  - `face.upstream_commit`     = `"hollance/BlazeFace-PyTorch@2c5b59d"`
- `scripts/face_embed_to_gguf.py` — fp16 conversion of either
  `arcface_mini_128` (buffalo_s MobileFaceNet) or `facenet_128`
  (InceptionResnetV1). Writes:
  - `face.embedder`            = one of `FACE_EMBEDDER_*`
  - `face.embedder_input_size` = `112`
  - `face.embedder_dim`        = `128`
  - `face.upstream_commit`     = `"facenet-pytorch==2.5.3"`

Both scripts validate their expected tensor names and metadata before
writing GGUF artifacts.

## elizaOS/llama.cpp fork integration

The runtime calls live in this library. The current implementation is a
pure-C scalar reference; a ggml dispatcher can be added behind the same
ABI using the standard 2-D conv / norm / activation ops both heads use:

1. **Keep BlazeFace parity.** Architecture is a small
   BlazeBlock-based feature extractor (depthwise + pointwise convs)
   plus per-stride classification and regression heads. All ops are
   already available in the fork (`ggml_conv_2d`, `ggml_norm`,
   ReLU/PReLU). Anchor decode (`face_anchor_decode.c`) is already done
   and tested; the model entry calls it after the forward pass and runs
   IoU-NMS on the result.
2. **Keep embedder parity.** Both supported families are
   convolutional (MobileFaceNet for arcface_mini_128;
   InceptionResnetV1 for facenet_128). The 5-point affine warp
   (`face_align.c`) is done and tested; the model entry calls it before
   the forward pass and L2-normalizes the 128-d output.
3. **Wire to the fork's dispatcher.** Expose a
   `face_set_ggml_backend(backend)` setter (mirroring
   `polarquant-cpu`'s registration path). `face_active_backend()`
   reports the bound backend's name.
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
cmake -B build -S packages/native/plugins/face-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libface.a`, `libface.so` (`.dylib` / `.dll` on other
platforms), plus native test binaries:
- `face_abi_smoke`     — public ABI links and error contracts hold.
- `face_anchor_test`   — anchor table + decode behaviour.
- `face_align_test`    — 5-point similarity warp + bilinear sampler.
- `face_distance_test` — cosine + L2 distance on unit-norm vectors.
- `face_runtime_test`  — detector runtime against a synthetic GGUF.
- `face_embed_runtime_test` — embedder runtime against a synthetic GGUF.

The optional Python parity test runs when its upstream dependencies and
fixtures are available.

## Remaining rollout work

- Parity test: ingest a small set of real face crops, run both the
  Python reference (`onnxruntime` BlazeFace + insightface buffalo_s)
  and this library, assert per-bbox IoU ≥ 0.95 and per-pair embedding
  cosine distance ≤ 0.05.
- Production rollout of the GGUF-backed plugin-vision bindings and
  migration of existing user face libraries when the embedding family
  changes.
- Optional ggml / SIMD dispatcher behind the same public ABI.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
