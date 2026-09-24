# voice-classifier-cpp

Standalone C runtime and GGUF converters for voice emotion, speaker embedding, diarization, and audio end-of-turn heads.

## Development

Build from this directory (requires CMake and a native compiler):

```bash
cmake -S . -B build && cmake --build build
```

Test the built library:

```bash
ctest --test-dir build --output-on-failure
```
