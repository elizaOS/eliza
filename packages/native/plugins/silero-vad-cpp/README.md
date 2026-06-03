# silero-vad-cpp

Standalone C library + GGUF conversion script that ports
[snakers4/silero-vad](https://github.com/snakers4/silero-vad)'s small
LSTM-based voice-activity classifier (~1.7M parameters, ~2 MB) to the
elizaOS/llama.cpp fork's ggml dispatcher. The output replaces
`plugins/plugin-local-inference/src/services/voice/vad.ts`'s ONNX path
and lets the runtime drop the `onnxruntime-node` dependency from the
voice front-end.

Today the model entry points are implemented by the native CPU runtime:
`silero_vad_open`, `silero_vad_reset_state`, `silero_vad_process`, and
`silero_vad_close` live in `src/silero_vad_runtime.c`. Two companion
TUs are exercised by ctest and used by the runtime:

- `src/silero_vad_state.c` — LSTM hidden / cell state container with
  `reset` + `promote` helpers.
- `src/silero_vad_resample.c` — linear PCM resampler so callers at
  8 / 22.05 / 44.1 kHz can normalize to the model's 16 kHz input.

The full port plan — upstream pin, GGUF conversion approach, fork
integration steps, replacement path for the TS adapter — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native/plugins/silero-vad-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libsilero_vad.a`, `libsilero_vad.so` (`.dylib` / `.dll` on
other platforms), `silero_vad_abi_smoke` (build-only ABI smoke),
`silero_vad_state_test` (LSTM state helpers), `silero_vad_resample_test`
(linear PCM resampler), and `silero_vad_runtime_test` (GGUF-backed
runtime behavior). Generate `build/silero-vad-v5.gguf` with the
converter before running the full ctest suite.

## GGUF conversion

The conversion script downloads or reads the pinned upstream ONNX model,
extracts the v5 16 kHz branch, and writes a fp16 GGUF file with locked
Silero metadata:

```
python scripts/silero_vad_to_gguf.py \
    --weights /path/to/silero_vad.jit-or-onnx \
    --output  /path/to/silero_vad.gguf
```

Canonical upstream model location:

> `https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad.onnx`

The conversion script records the pinned upstream commit in the GGUF
metadata key `silero_vad.upstream_commit`; the runtime refuses to
load any GGUF whose pin doesn't match the header's expected commit.

## Layout

```
include/silero_vad/silero_vad.h   Public C ABI (frozen — see AGENTS.md).
src/silero_vad_runtime.c          Native CPU model runtime.
src/silero_vad_state.[ch]         LSTM hidden/cell state helpers.
src/silero_vad_resample.c         Linear PCM resampler.
scripts/silero_vad_to_gguf.py     ONNX-to-GGUF converter.
test/silero_vad_abi_smoke.c       Build-only ABI smoke.
test/silero_vad_state_test.c      Test for the state helpers.
test/silero_vad_resample_test.c   Test for the linear resampler.
test/silero_vad_runtime_test.c    GGUF-backed runtime behavior test.
CMakeLists.txt                    Builds libsilero_vad + native tests.
```

## License

MIT — matches snakers4/silero-vad's license. The pinned upstream
commit recorded in `scripts/silero_vad_to_gguf.py` is the source of
the weights this library ships against.
