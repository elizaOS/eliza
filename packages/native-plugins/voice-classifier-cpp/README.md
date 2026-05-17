# voice-classifier-cpp

Standalone C library + GGUF conversion scripts that port three small
voice-side classifiers to the elizaOS/llama.cpp fork's ggml dispatcher,
replacing the onnxruntime-node path used today by the voice services in
`plugins/plugin-local-inference/src/services/voice/`:

- **Voice emotion classifier** — 7-class basic-emotion soft probabilities.
- **End-of-turn detector** — audio-side P(end_of_turn) ∈ [0, 1].
- **Speaker embedding encoder** — 192-dim ECAPA-style embedding plus a
  cosine-distance helper.

Today the **model entry points are stubs** (every `voice_*_open` /
`voice_*_classify` / `voice_*_score` / `voice_*_embed` returns
`-ENOSYS`). The shared utilities are real:

- `voice_emotion_class_name` returns the canonical class names in the
  pinned 7-class order;
- `voice_speaker_distance` is a real cosine-distance implementation;
- `voice_mel_compute` is a real shared log-mel front-end (n_mels=80,
  n_fft=512, hop=160 at 16 kHz).

The full port plan — upstream pins, GGUF schema per head, fork
integration steps, replacement path for the TS services — lives in
[`AGENTS.md`](AGENTS.md). Read that before changing anything in this
directory.

## Build

```
cmake -B packages/native-plugins/voice-classifier-cpp/build \
      -S packages/native-plugins/voice-classifier-cpp
cmake --build packages/native-plugins/voice-classifier-cpp/build -j
ctest --test-dir packages/native-plugins/voice-classifier-cpp/build --output-on-failure
```

Builds `libvoice_classifier.a` and four test binaries:

| Test                            | What it asserts                                                 |
| ------------------------------- | --------------------------------------------------------------- |
| `voice_classifier_stub_smoke`   | The three model heads still return `-ENOSYS` and clear out-args |
| `voice_emotion_classes_test`    | The 7-class vocabulary order is intact                          |
| `voice_speaker_distance_test`   | Cosine distance: identical=0, orthogonal=1, opposite=2          |
| `voice_mel_features_test`       | A 1 kHz sine wave peaks in the low-mid mel band                 |

## Layout

```
include/voice_classifier/voice_classifier.h  Public C ABI (frozen — see AGENTS.md).
src/voice_classifier_stub.c                  ENOSYS stub for the three model heads.
src/voice_emotion_classes.c                  Real: 7-class name table.
src/voice_speaker_distance.c                 Real: cosine distance helper.
src/voice_mel_features.c                     Real: shared log-mel front-end.
scripts/voice_emotion_to_gguf.py             Skeleton converter (TODO blocks documented).
scripts/voice_eot_to_gguf.py                 Skeleton converter.
scripts/voice_speaker_to_gguf.py             Skeleton converter.
test/                                        Four ctest binaries; see table above.
CMakeLists.txt                               Builds libvoice_classifier + tests.
```

## License

Apache 2.0 — matches the suggested ECAPA-TDNN upstream
(`speechbrain/spkrec-ecapa-voxceleb`). The pinned upstream commits for
each head are recorded in the corresponding `scripts/voice_*_to_gguf.py`
file at conversion time.
