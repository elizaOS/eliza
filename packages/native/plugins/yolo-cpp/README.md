# yolo-cpp

Standalone C library + GGUF conversion script that ports
Ultralytics' [YOLOv8n / YOLOv11n](https://github.com/ultralytics/ultralytics)
COCO object detection from `onnxruntime-node` to the
elizaOS/llama.cpp fork's ggml dispatcher. The output replaces
`plugins/plugin-vision/src/yolo-detector.ts` with a native, GGUF-
backed detector that the existing `PersonDetector` consumes
unchanged.

Today this is a **partial port** (Phase 2): the runtime can load and
validate YOLO GGUF files, and detection is staged at the forward pass.

- `src/yolo_classes.c` — real COCO-80 class lookup.
- `src/yolo_nms.c` — real per-class non-max suppression.
- `src/yolo_postprocess.c` — real decoupled-head decode.
- `src/yolo_gguf.c` — real GGUF v3 reader (mmap, fp16/fp32 tensors,
  metadata validation).
- `src/yolo_letterbox.c` — real Ultralytics-style RGB letterbox +
  CHW fp32 preprocessor.
- `src/yolo_kernels.c` — scalar Conv2D / BN-fold / SiLU / concat /
  upsample / pooling / softmax kernels for the forward schedule.
- `src/yolo_runtime.c` — `yolo_open` loads and validates GGUF
  sessions, `yolo_close` releases them, `yolo_active_backend` reports
  `"cpu-ref"`, and `yolo_detect` runs the real preprocessor before
  returning `-ENOSYS` for the staged forward pass.

The C ABI declared in `include/yolo/yolo.h` is fully wired and the
build emits `libyolo.a`, `libyolo.so`, and five test binaries that all
pass.

The full port plan — upstream pin, GGUF conversion approach, fork
integration steps, replacement path for the TS adapter — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native/plugins/yolo-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libyolo.a`, `libyolo.so`, plus
- `yolo_abi_smoke` — ABI link probe; asserts lifecycle and errno
  contracts against the real runtime.
- `yolo_nms_test` — real test for `yolo_nms_inplace` against a 5-box
  cluster covering same-class suppression, cross-class survival, and
  disjoint-geometry survival.
- `yolo_classes_test` — verifies the COCO-80 lookup table
  (`person`, `toothbrush`, NULL on out-of-range).
- `yolo_letterbox_test` — verifies preprocessor identity, center-pad,
  and grey-pad behaviour.
- `yolo_runtime_test` — verifies backend tag, GGUF open failure
  handling, and optional real-GGUF open + staged-forward detection path.

## GGUF conversion

`scripts/yolo_to_gguf.py` converts Ultralytics YOLOv8n / YOLOv11n
checkpoints into a single GGUF with Conv tensors, BN sidecar stats,
decoupled-head tensors, locked metadata, and strict checkpoint-key
validation. Run order, expected inputs, and metadata key contract are
documented at the top of the file.

```
python scripts/yolo_to_gguf.py \
    --checkpoint /path/to/yolov8n.pt \
    --variant    yolov8n \
    --output     ~/.eliza/models/yolo/yolov8n.gguf
```

## Layout

```
include/yolo/yolo.h          Public C ABI (frozen — see AGENTS.md).
src/yolo_classes.c           Real COCO-80 class table.
src/yolo_nms.c               Real per-class NMS.
src/yolo_postprocess.c       Real decoupled-head decode.
src/yolo_gguf.c              GGUF reader and metadata/tensor accessors.
src/yolo_letterbox.c         RGB letterbox + CHW fp32 preprocessor.
src/yolo_kernels.c           Scalar reference NN kernels.
src/yolo_runtime.c           GGUF-backed runtime and staged detect path.
src/yolo_internal.h          Library-private helpers (NMS, decode).
scripts/yolo_to_gguf.py      Strict Ultralytics checkpoint to GGUF converter.
test/yolo_abi_smoke.c        ABI link probe.
test/yolo_nms_test.c         Real NMS behaviour test.
test/yolo_classes_test.c     Real class table test.
test/yolo_letterbox_test.c   Real preprocessor behaviour test.
test/yolo_runtime_test.c     Runtime open / staged-forward test.
CMakeLists.txt               Builds libyolo + the test binaries.
```

## License

AGPL-3.0 — matches Ultralytics' license. The pinned upstream commit
recorded in `scripts/yolo_to_gguf.py` is the source of the weights
this library ships against.
