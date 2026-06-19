# yolo.cpp — ggml YOLOv8n object detector

A self-contained C++ forward pass for **YOLOv8n** built directly on
[ggml](https://github.com/ggml-org/ggml). The CNN (backbone `Conv`/`C2f`/`SPPF`
→ PAN-FPN neck → decoupled head) runs in ggml; letterbox preprocessing, the
final box decode and NMS stay in TypeScript (`src/yolo-detector.ts`). The DFL
distribution decode, anchor/stride decode, and class sigmoid run in C++ here.

ggml is linked **statically**, so the build artifact `build/libyolo.<ext>` is a
single self-contained shared library with no external `ggml.dll`/`.so`
dependency — `bun:ffi` loads it directly.

## Status: working & verified

`src/yolo.cpp` produces detections that match the upstream Ultralytics PyTorch
model to within fp32 rounding (box max |Δ| ≈ 0.001 px, class scores exact). See
`verify/` for the numerical check against a PyTorch reference.

## Build

Requires CMake ≥ 3.20 and a C/C++ toolchain (MSVC Build Tools on Windows,
clang/gcc elsewhere). From the plugin root:

```bash
bun run build:native              # → native/yolo.cpp/build/libyolo.{dll,dylib,so}
# or directly:
bun native/yolo.cpp/build.mjs            # CPU
bun native/yolo.cpp/build.mjs --metal    # macOS GPU
bun native/yolo.cpp/build.mjs --cuda     # NVIDIA GPU
```

## Convert weights → GGUF

Ultralytics ships under AGPL-3.0; we ship **no weights**. Convert them locally
(BatchNorm is folded into each conv at convert time):

```bash
pip install ultralytics gguf numpy torch
bun run build:weights             # → ~/.eliza/models/vision/yolov8n.gguf
# or directly:
python native/yolo.cpp/scripts/convert.py --variant yolov8n
```

The runtime resolves the GGUF at `$ELIZA_STATE_DIR/models/vision/yolov8n.gguf`
(default `~/.eliza/...`); override with `ELIZA_YOLO_GGUF`. Override the library
path with `ELIZA_YOLO_LIB` and the CPU thread count with `ELIZA_YOLO_THREADS`
(defaults to ≈ physical cores).

## Verify (numerical parity with PyTorch)

```bash
python native/yolo.cpp/verify/make_ref.py        # input.bin + ultralytics ref.bin
bun    native/yolo.cpp/verify/run_ggml.mjs build/libyolo.dll <gguf>   # → out.bin
python native/yolo.cpp/verify/compare.py         # asserts PASS

# full TS path (FFI → parseYoloV8 → NMS) on a real image:
bun native/yolo.cpp/verify/run_ts.mjs
```

## License

The runtime in this directory is a clean-room implementation built on ggml. It
contains no Ultralytics code. YOLOv8 weights are AGPL-3.0 and are **not** bundled
— end users convert them locally via the script above.
