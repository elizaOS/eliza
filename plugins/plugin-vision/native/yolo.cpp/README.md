# yolo.cpp — ggml YOLOv8n object detector

A self-contained C++ forward pass for **YOLOv8n** built directly on [ggml](https://github.com/ggml-org/ggml).

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

No CTest suite is registered here; verify runtime integration through the owning plugin.
