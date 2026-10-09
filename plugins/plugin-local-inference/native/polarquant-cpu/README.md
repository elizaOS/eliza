# polarquant-cpu

Standalone C reference and SIMD library for the Q4 PolarQuant block format.

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

Test the built library:

```bash
ctest --test-dir build --output-on-failure
```
