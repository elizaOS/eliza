# yolo.cpp — ggml port of YOLOv8

C++ forward pass for YOLOv8 detection models built on
[ggml](https://github.com/ggml-org/ggml). Letterbox preprocessing, anchor-free
output decode, and NMS stay in TypeScript (see
`plugins/plugin-vision/src/yolo-detector.ts`); this library runs only the CNN.

## Status

**Phase 2 (current):** FFI surface scaffolded; conversion script authored.
Native lib + GGUF weights not yet built. The TS binding throws a clear error
until both are present.

## Build (when implemented)

```bash
cd plugins/plugin-vision/native/yolo.cpp
cmake -B build -S . -DYOLO_WITH_METAL=ON   # macOS arm64
cmake --build build --config Release
```

## Convert weights (when implemented)

```bash
python scripts/convert.py --variant yolov8n --out vision/yolov8n.gguf
```

## License

The runtime in this directory is a clean-room implementation. Ultralytics
YOLOv8 weights are AGPL-3.0; this repo does not bundle them. End users fetch
weights at runtime or via the model-publish workflow that already exists for
the llama.cpp text/vision tiers.
