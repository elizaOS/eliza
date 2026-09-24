# PolarQuant Q4 — `Apothic-AI/llama.cpp-1bit-turboquant` integration

This directory holds the patch set + drop-in source files that register `block_q4_polar` (`GGML_TYPE_Q4_POLAR = 47`) inside the elizaOS llama.cpp fork.

This directory is part of `plugins/plugin-local-inference/native/polarquant-cpu`.

Build the owning library from this directory (requires CMake and a native compiler):

```bash
cmake -S .. -B ../build && cmake --build ../build
```

Test the built library:

```bash
ctest --test-dir ../build --output-on-failure
```
