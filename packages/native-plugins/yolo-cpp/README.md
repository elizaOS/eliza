# yolo-cpp

Standalone C library + GGUF conversion script that ports
Ultralytics' [YOLOv8n / YOLOv11n](https://github.com/ultralytics/ultralytics)
COCO object detection from `onnxruntime-node` to the
elizaOS/llama.cpp fork's ggml dispatcher. The output replaces
`plugins/plugin-vision/src/yolo-detector.ts` with a native, GGUF-
backed detector that the existing `PersonDetector` consumes
unchanged.

Today this is a **partial port** (Phase 1):

- `src/yolo_classes.c` — real COCO-80 class lookup.
- `src/yolo_nms.c` — real per-class non-max suppression.
- `src/yolo_postprocess.c` — real decoupled-head decode.
- `src/yolo_stub.c` — ENOSYS stub for the four entry points that
  depend on the ggml graph (`yolo_open`, `yolo_detect`,
  `yolo_active_backend`; `yolo_close` is NULL-safe and returns 0).

The C ABI declared in `include/yolo/yolo.h` is fully wired and the
build emits `libyolo.a` plus three test binaries that all pass.

The full port plan — upstream pin, GGUF conversion approach, fork
integration steps, replacement path for the TS adapter — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native-plugins/yolo-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libyolo.a` plus
- `yolo_stub_smoke` — ABI link probe; asserts the graph-backed entry
  points still report `-ENOSYS`.
- `yolo_nms_test` — real test for `yolo_nms_inplace` against a 5-box
  cluster covering same-class suppression, cross-class survival, and
  disjoint-geometry survival.
- `yolo_classes_test` — verifies the COCO-80 lookup table
  (`person`, `toothbrush`, NULL on out-of-range).

## GGUF conversion

`scripts/yolo_to_gguf.py` is a SKELETON. The TODO blocks document
each layer family that needs converting (Conv2d → fp16, BN → fp32
sidecar stats, decoupled head). Run order, expected inputs, and
metadata key contract are documented at the top of the file. The
script raises `NotImplementedError` until those TODOs land so a
half-built converter cannot pass for working.

```
python scripts/yolo_to_gguf.py \
    --checkpoint /path/to/yolov8n.pt \
    --variant    yolov8n \
    --output     ~/.milady/models/yolo/yolov8n.gguf
```

## Layout

```
include/yolo/yolo.h          Public C ABI (frozen — see AGENTS.md).
src/yolo_classes.c           Real COCO-80 class table.
src/yolo_nms.c               Real per-class NMS.
src/yolo_postprocess.c       Real decoupled-head decode.
src/yolo_stub.c              ENOSYS stub for graph entry points.
src/yolo_internal.h          Library-private helpers (NMS, decode).
scripts/yolo_to_gguf.py      Skeleton converter; TODO blocks documented.
test/yolo_stub_smoke.c       ABI link probe.
test/yolo_nms_test.c         Real NMS behaviour test.
test/yolo_classes_test.c     Real class table test.
CMakeLists.txt               Builds libyolo + the three test binaries.
```

## License

AGPL-3.0 — matches Ultralytics' license. The pinned upstream commit
recorded in `scripts/yolo_to_gguf.py` is the source of the weights
this library ships against.
