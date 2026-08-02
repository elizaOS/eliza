# `silero-vad-cpp` native reference runtime

Standalone C implementation and GGUF converter for Silero VAD v5 at 16 kHz.

## Scope and status

This package implements a real scalar-C Silero forward path, recurrent state, resampling, and a stable C ABI. It is not the production TypeScript voice backend. `@elizaos/plugin-local-inference` uses `GgmlSileroVad` in `plugins/plugin-local-inference/src/services/voice/vad.ts`, which calls the fused `libelizainference` VAD ABI. There is no production `vad-ggml.ts` binding or standalone-library fallback.

Keep this package as an independently verifiable reference and conversion surface unless the runtime architecture is deliberately changed. Do not add it to the provider order without reconciling the single-fused-runtime policy and proving real-audio parity.

## Source map

```
include/silero_vad/silero_vad.h  stable session ABI
src/silero_vad_runtime.c         GGUF loader and scalar forward pass
src/silero_vad_state.c           recurrent state helpers
src/silero_vad_resample.c        PCM resampling to 16 kHz
scripts/silero_vad_to_gguf.py     pinned ONNX-to-GGUF conversion
test/                             ABI, state, resample, runtime, and parity tests
```

The converter targets the 16 kHz branch of Silero VAD v5 at upstream commit `980b17e9d56463e51393a8d92ded473f1b17896a`. One model call consumes 512 samples (32 ms) and returns one speech probability. Preserve the 64-sample context carry and 128-dimensional LSTM state; they are required for upstream parity.

## ABI rules

- `silero_vad_process` accepts exactly one 512-sample, 16 kHz window.
- Session state is reset explicitly at utterance boundaries.
- Separate sessions are reentrant; shared sessions require caller synchronization.
- Errors are negative errno-style values. Missing or malformed models fail; they never become silence.
- Backend acceleration must remain behind `include/silero_vad/silero_vad.h` and report through `silero_vad_active_backend()`.

## Build and verification

```bash
cmake -B packages/native/plugins/silero-vad-cpp/build -S packages/native/plugins/silero-vad-cpp
cmake --build packages/native/plugins/silero-vad-cpp/build -j
python3 packages/native/plugins/silero-vad-cpp/scripts/silero_vad_to_gguf.py --output packages/native/plugins/silero-vad-cpp/build/silero-vad-v5.gguf
ctest --test-dir packages/native/plugins/silero-vad-cpp/build --output-on-failure
```

Run the Python parity test with the real upstream artifact when changing conversion or inference. Review probability traces over speech, silence, boundaries, and resets. Follow the repository-wide evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md).
