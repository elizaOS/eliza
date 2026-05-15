# face-cpp

Standalone C library + GGUF conversion scripts that port BlazeFace
(face detection) and a 128-d face embedding network (FaceNet-style
or ArcFace-mini) onto the elizaOS/llama.cpp fork's ggml dispatcher.
Once it lands it replaces `face-detector-mediapipe.ts` (ONNX) and
`face-recognition.ts` (face-api.js / TensorFlow.js / ONNX) in
plugin-vision.

Today the model entry points in `include/face/face.h` are a **stub**
(`face_detect_open`, `face_detect`, `face_embed_open`, `face_embed`
return `-ENOSYS`) but the model-independent helpers are real and
tested:

- `face_blazeface_make_anchors` — 896-anchor table for the
  128x128 BlazeFace front model.
- `face_blazeface_decode` — decode raw model outputs to
  source-pixel detections.
- `face_align_5pt` — 5-point similarity warp + bilinear sampler
  producing a 112x112 RGB face crop.
- `face_embed_distance` / `face_embed_distance_l2` — cosine and L2
  distance over unit-norm 128-d embeddings.

The full port plan — upstream pins, GGUF conversion approach, fork
integration steps, replacement path for the TS bindings — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native-plugins/face-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Layout

```
include/face/face.h           Public C ABI (frozen — see AGENTS.md).
src/face_stub.c               ENOSYS stub for the model entries.
src/face_anchor_decode.c      BlazeFace anchor table + decoder (real).
src/face_align.c              5-point affine warp + bilinear sampler (real).
src/face_distance.c           Cosine + L2 distance helpers (real).
scripts/blazeface_to_gguf.py  BlazeFace converter; TODO blocks documented.
scripts/face_embed_to_gguf.py Embedder converter; TODO blocks documented.
test/face_stub_smoke.c        Build-only smoke test for the stub model ABI.
test/face_anchor_test.c       Behavioural test for the anchor pipeline.
test/face_align_test.c        Behavioural test for the 5-point aligner.
test/face_distance_test.c     Behavioural test for the distance helpers.
CMakeLists.txt                Builds libface + the four test binaries.
```

## License

Apache 2.0 — matches both google/mediapipe (BlazeFace) and
deepinsight/insightface (ArcFace-mini buffalo_s pack). The pinned
upstream commits recorded in `scripts/*.py` are the source of the
weights this library ships against.
