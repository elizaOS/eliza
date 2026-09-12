# face-cpp

Native C library for BlazeFace detection and 128-dimensional face embeddings
from GGUF models. `@elizaos/plugin-vision` consumes its detector and embedder
ABI. The runtime uses portable scalar CPU kernels and reports the
`ggml-cpu-ref` backend.

Detection and embedding have separate opaque session handles. Embedding
comparisons require normalized vectors from the same model family; switching
families requires re-embedding stored profiles. See [CLAUDE.md](CLAUDE.md) for
ABI constraints, upstream pins, and integration verification requirements.

## Build

```
cmake -B build -S packages/native/plugins/face-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Layout

```
include/face/face.h           Public C ABI (frozen — see AGENTS.md).
src/face_model.c              Native CPU model runtime.
src/face_blazeface.c          BlazeFace forward path.
src/face_embed.c              128-d embedder forward path.
src/face_anchor_decode.c      BlazeFace anchor table + decoder.
src/face_align.c              5-point affine warp + bilinear sampler.
src/face_distance.c           Cosine + L2 distance helpers.
scripts/blazeface_to_gguf.py  BlazeFace converter.
scripts/face_embed_to_gguf.py Embedder converter.
test/face_abi_smoke.c         ABI compatibility smoke test.
test/face_anchor_test.c       Behavioural test for the anchor pipeline.
test/face_align_test.c        Behavioural test for the 5-point aligner.
test/face_distance_test.c     Behavioural test for the distance helpers.
CMakeLists.txt                Builds libface + native test binaries.
```

## License

Apache 2.0 — matches both google/mediapipe (BlazeFace) and
deepinsight/insightface (ArcFace-mini buffalo_s pack). The pinned
upstream commits recorded in `scripts/*.py` are the source of the
weights this library ships against.
