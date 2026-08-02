# `yolo-cpp` native reference runtime

Standalone C reference implementation and conversion tooling for YOLOv8n/YOLOv11n GGUF object detection.

## Scope and status

This package is not the detector loaded by `@elizaos/plugin-vision`. The shipping plugin binding in `plugins/plugin-vision/src/native/yolo-ffi.ts` targets `plugins/plugin-vision/native/yolo.cpp`. Keep the two ABIs and build paths distinct unless they are intentionally consolidated.

The public `yolo_open`/`yolo_detect`/`yolo_close` ABI is defined in `include/yolo/yolo.h`. Model loading, metadata validation, letterboxing, scalar kernels, class lookup, post-processing, and NMS are implemented. The model forward schedule is not: `yolo_detect` deliberately returns `-ENOSYS` after preprocessing, and `yolo_active_backend()` reports `cpu-ref`. Do not advertise this library as a usable detector or add a silent fallback.

## Source map

```
include/yolo/yolo.h        stable C ABI
src/yolo_runtime.c         session lifecycle and staged detect entry
src/yolo_gguf.c            GGUF reader and metadata validation
src/yolo_letterbox.c       RGB-to-CHW resize and padding
src/yolo_kernels.c         scalar convolution and activation kernels
src/yolo_postprocess.c     head decoding
src/yolo_nms.c             per-class non-max suppression
src/yolo_classes.c         COCO-80 labels
scripts/yolo_to_gguf.py    pinned Ultralytics converter
test/                      ABI, loader, preprocessing, NMS, and parity tests
```

The converter is pinned to Ultralytics `v8.4.51`, commit `14ea57b11969cd872f15291e5d0bdc965bdb59f7`, and records the pin in GGUF metadata. It accepts the `yolov8n` and `yolov11n` variants. Preserve converter validation and metadata checks when changing the format.

## ABI rules

- Detection coordinates are source-image pixel coordinates with a top-left origin.
- Separate handles are reentrant; sharing one handle requires caller synchronization.
- Errors use negative errno-style values. Missing models and invalid shapes are failures, not empty detections.
- `-ENOSPC` reports the required output count so callers can resize.
- `-ENOSYS` remains the honest signal until the full forward graph and parity gate are implemented.
- Backend or SIMD work stays behind the existing ABI.

## Build and verification

```bash
cmake -B packages/native/plugins/yolo-cpp/build -S packages/native/plugins/yolo-cpp
cmake --build packages/native/plugins/yolo-cpp/build -j
ctest --test-dir packages/native/plugins/yolo-cpp/build --output-on-failure
```

The parity test may skip only because the forward path is explicitly staged; it must become a hard real-artifact gate before this runtime is promoted. Follow the repository-wide evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md).
