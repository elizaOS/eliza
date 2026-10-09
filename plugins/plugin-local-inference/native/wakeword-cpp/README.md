# wakeword-cpp

Standalone C implementation of the three-stage openWakeWord pipeline over GGUF artifacts.

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

Test the built library:

```bash
ctest --test-dir build --output-on-failure
```
