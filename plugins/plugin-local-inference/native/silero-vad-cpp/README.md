# silero-vad-cpp

Standalone C implementation and GGUF converter for Silero VAD v5 at 16 kHz.

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

Test the built library:

```bash
ctest --test-dir build --output-on-failure
```
