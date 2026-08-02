# `doctr-cpp` native reference runtime

Standalone C reference implementation of docTR detection and recognition heads over GGUF artifacts.

## Scope and status

This package defines a stable detector/recognizer C ABI and scalar reference runtime. It is not the library currently loaded by `@elizaos/plugin-vision`: that plugin's `src/native/doctr-ffi.ts` targets `plugins/plugin-vision/native/doctr.cpp`. Keep these build paths distinct unless they are intentionally consolidated.

The package is useful for deterministic converter, loader, ABI, and numerical work. Promotion into plugin-vision requires real document parity and an explicit binding change; the presence of `libdoctr.a` alone is not production readiness.

## Model and ABI

`scripts/doctr_to_gguf.py` targets docTR `python-doctr==1.0.1`, with `db_resnet50` detection and `crnn_vgg16_bn` recognition. It records and validates the upstream pin and fixed input metadata.

`include/doctr/doctr.h` defines:

- session open/close
- source-image detection boxes
- word-crop recognition with caller-owned UTF-8/confidence output
- backend diagnostics

Errors are negative errno-style values. `-ENOSPC` returns the required detection count; missing or invalid models do not become empty OCR.

## Layout

```
include/doctr/doctr.h       stable public ABI
src/doctr_runtime.c         session and dispatch
src/doctr_gguf.c            GGUF loading and validation
src/doctr_image.c           image normalization and resizing
src/doctr_detector_ref.c    DBNet detector reference
src/doctr_recognizer_ref.c  CRNN/CTC recognizer reference
src/doctr_polygon.c         detector post-processing
src/doctr_ctc.c             greedy CTC decoding
src/doctr_kernels.c         scalar kernels
scripts/doctr_to_gguf.py    pinned converter
test/doctr_abi_smoke.c      ABI and error-path smoke
```

## Build and verification

```bash
cmake -B packages/native/plugins/doctr-cpp/build -S packages/native/plugins/doctr-cpp
cmake --build packages/native/plugins/doctr-cpp/build -j
ctest --test-dir packages/native/plugins/doctr-cpp/build --output-on-failure
```

ABI smoke is necessary but not sufficient. Converter or inference changes require real document/page crops, box IoU comparison, word-level accuracy/edit distance, multilingual and rotated text, malformed images, and missing-model failure checks. If integrating with plugin-vision, run its actual coordinate-OCR and computer-use bridge.

## Constraints

- Coordinates are absolute source-image pixels.
- Distinct sessions are reentrant; shared sessions require caller synchronization.
- Preserve detector/recognizer metadata and vocabulary ordering across converter and runtime.
- Backend acceleration remains behind the public ABI.
- Do not claim replacement of the plugin-vision runtime until its binding and real-artifact tests use this library.

Follow the repository-wide verification standard in the [root CLAUDE.md](../../../../CLAUDE.md). Review recognized text, boxes, confidence, latency, memory, and unavailable states.
