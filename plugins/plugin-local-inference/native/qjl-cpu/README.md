# qjl-cpu

Standalone C reference and SIMD library for QJL 1-bit Johnson–Lindenstrauss key-cache compression.

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

Test the built library:

```bash
ctest --test-dir build --output-on-failure
```
