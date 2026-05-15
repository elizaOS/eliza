# wakeword-cpp

Standalone C library + GGUF conversion script that ports
[openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0)
off `onnxruntime-node` and onto the elizaOS/llama.cpp fork's ggml
dispatcher. Output replaces the ONNX-runtime-backed
`OpenWakeWordModel` in
`plugins/plugin-local-inference/src/services/voice/wake-word.ts`.

Today the public C ABI declared in `include/wakeword/wakeword.h` is a
**stub** — every entry point returns `-ENOSYS` from
`src/wakeword_stub.c`. The melspectrogram and sliding-window TUs are
real and tested in isolation; they will be linked into the non-stub
implementation when Phase 2 brings up the ggml-backed embedding +
classifier graphs.

The full port plan — upstream pin, three-stage pipeline, GGUF
conversion, fork integration, replacement path — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native-plugins/wakeword-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libwakeword.a` plus three test binaries:

- `wakeword_stub_smoke` — public ABI returns `-ENOSYS`, NULL handles
  do not crash.
- `wakeword_melspec_test` — 1 kHz / 4 kHz tones land in the right mel
  bin (±100 Hz / ±400 Hz tolerance).
- `wakeword_window_test` — 80 ms framing emits one frame per 1280
  samples, no drift across 5 s of PCM.

## Layout

```
include/wakeword/wakeword.h     Public C ABI (frozen — see AGENTS.md).
src/wakeword_internal.h         Shared dimensions for the real TUs.
src/wakeword_stub.c             ENOSYS stub for the public ABI.
src/wakeword_melspec.c          Pure-C log-mel spectrogram (real).
src/wakeword_window.c           80 ms sliding-window framer (real).
scripts/wakeword_to_gguf.py     Skeleton converter; TODO blocks documented.
test/wakeword_stub_smoke.c      Build-only smoke for the stub ABI.
test/wakeword_melspec_test.c    Spectral correctness for the melspec.
test/wakeword_window_test.c     Framing timing + content for the windower.
CMakeLists.txt                  Builds libwakeword + three test binaries.
```

## License

Apache 2.0 — matches dscripka/openWakeWord. The pinned upstream commit
recorded in `scripts/wakeword_to_gguf.py` is the source of the weights
this library ships against.
