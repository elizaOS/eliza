# `face-cpp` native runtime

Native BlazeFace detection and 128-dimensional face embedding over GGUF artifacts.

## Role

This package owns the C ABI consumed by `@elizaos/plugin-vision` through `plugins/plugin-vision/src/face-detector-ggml.ts` and `plugins/plugin-vision/src/face-recognition-ggml.ts`. The old MediaPipe/ONNX module is only a fail-closed compatibility shim; new work belongs on the native path.

Detection and embedding share `include/face/face.h` but use separate opaque handles. The implementation includes model loading, scalar forwards, anchor decoding, NMS, five-point alignment, embedding normalization, and cosine/L2 distance helpers.

## Source map

```
include/face/face.h             stable detector and embedder ABI
src/face_model.c                model/session composition
src/face_blazeface.c            BlazeFace forward path
src/face_embed.c                embedding forward path
src/face_gguf.c                 GGUF loading and validation
src/face_anchor_decode.c        896-anchor decoding
src/face_align.c                five-point similarity alignment
src/face_image.c                image preprocessing
src/face_distance.c             embedding distances
src/face_nms.c                  detection suppression
src/face_kernels.c              scalar kernels
scripts/blazeface_to_gguf.py    detector converter
scripts/face_embed_to_gguf.py   embedder converter
test/                           ABI, runtime, alignment, distance, hostile GGUF, and parity
```

The detector converter is pinned to `hollance/BlazeFace-PyTorch@2c5b59d`. The shipped embedding family is `facenet_128`, pinned to `facenet-pytorch==2.5.3`; `arcface_mini_128` remains an ABI-compatible identifier, not the default artifact.

## ABI rules

- Boxes and landmarks use source-image absolute pixel coordinates with a top-left origin.
- BlazeFace landmarks stay ordered as eyes, nose, mouth, and ears according to the header.
- Embeddings are L2-normalized 128-element vectors. Embeddings from different model families are not comparable and require re-embedding user profiles.
- Separate handles are reentrant; sharing a handle requires caller synchronization.
- Missing libraries, invalid GGUF metadata, malformed images, and output overflow return explicit errors. Never fabricate faces or embeddings.
- SIMD or ggml dispatch changes stay behind the public ABI and update `face_active_backend()`.

## Build and verification

```bash
cmake -B packages/native/plugins/face-cpp/build -S packages/native/plugins/face-cpp
cmake --build packages/native/plugins/face-cpp/build -j
ctest --test-dir packages/native/plugins/face-cpp/build --output-on-failure
```

For detector or embedder changes, also exercise the plugin-vision bindings with real model artifacts and real face fixtures. Review box parity, false positives, alignment crops, embedding distances, and unavailable states. Follow the repository-wide evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md).
