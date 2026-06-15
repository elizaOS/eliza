# wakeword-cpp

Standalone C library + GGUF conversion script that ports
[openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0)
off `onnxruntime-node` and into a pure-C runtime. The TypeScript
counterpart in
`plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts`
binds the shared library through `bun:ffi`, and
`plugins/plugin-local-inference/src/services/voice/wake-word.ts`
prefers this standalone runtime when the library and GGUF files are
available.

The public C ABI declared in `include/wakeword/wakeword.h` is backed by
`src/wakeword_runtime.c`. It loads three GGUFs per session
(melspectrogram, embedding CNN, classifier head), processes streaming
16 kHz mono PCM, and returns the most recent classifier probability.

The full port plan — upstream pin, three-stage pipeline, GGUF
conversion, fork integration, replacement path — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B build -S packages/native/plugins/wakeword-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libwakeword.a`, `libwakeword.so`/`.dylib`/`.dll`, and four test
binaries:

- `wakeword_stub_smoke` — historical target name; public ABI link/error
  contract smoke for NULL arguments, missing files, and NULL handles.
- `wakeword_melspec_test` — 1 kHz / 4 kHz tones land in the right mel
  bin (±100 Hz / ±400 Hz tolerance).
- `wakeword_window_test` — 80 ms framing emits one frame per 1280
  samples, no drift across 5 s of PCM.
- `wakeword_runtime_test` — opens the three GGUFs and runs silence plus
  a synthesized chirp through the real runtime.

## Layout

```
include/wakeword/wakeword.h     Public C ABI (frozen — see AGENTS.md).
src/wakeword_internal.h         Shared dimensions for the real TUs.
src/wakeword_melspec.c          Pure-C log-mel spectrogram (real).
src/wakeword_window.c           80 ms sliding-window framer (real).
src/wakeword_runtime.c          Real three-GGUF streaming runtime.
scripts/wakeword_to_gguf.py     ONNX-to-GGUF converter.
test/wakeword_stub_smoke.c      Historical filename; public ABI smoke.
test/wakeword_melspec_test.c    Spectral correctness for the melspec.
test/wakeword_runtime_test.c    Runtime smoke with GGUF fixtures.
test/wakeword_window_test.c     Framing timing + content for the windower.
CMakeLists.txt                  Builds libwakeword + three test binaries.
```

## License

Apache 2.0 — matches dscripka/openWakeWord. The pinned upstream commit
recorded in `scripts/wakeword_to_gguf.py` is the source of the weights
this library ships against.
