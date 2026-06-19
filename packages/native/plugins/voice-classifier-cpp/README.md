# voice-classifier-cpp

Standalone C library + GGUF conversion scripts that port native
voice-side classifiers to the elizaOS/llama.cpp fork's ggml dispatcher,
replacing the onnxruntime-node path used today by the voice services in
`plugins/plugin-local-inference/src/services/voice/`:

- **Voice emotion classifier** — 7-class basic-emotion soft probabilities.
- **End-of-turn detector** — audio-side P(end_of_turn) ∈ [0, 1].
- **Speaker embedding encoder** — 256-dim WeSpeaker embedding plus a
  cosine-distance helper.
- **Diarizer** — pyannote-3 segmentation powerset labels.

Current native status:

- emotion, speaker, and diarizer load GGUF metadata/tensors and run scalar C
  forward passes;
- audio EOT loads and validates GGUF metadata, then returns `-ENOSYS` from the
  forward pass until an upstream audio-turn model is pinned;
- the production TypeScript services still use their ONNX/runtime paths until
  the GGUF bindings and parity gates are promoted.

The shared utilities are real:

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
cmake -B packages/native/plugins/voice-classifier-cpp/build \
      -S packages/native/plugins/voice-classifier-cpp
cmake --build packages/native/plugins/voice-classifier-cpp/build -j
ctest --test-dir packages/native/plugins/voice-classifier-cpp/build --output-on-failure
```

Builds `libvoice_classifier.a`, `libvoice_classifier.dylib`/shared equivalent,
and the ctest binaries:

| Test                            | What it asserts                                                 |
| ------------------------------- | --------------------------------------------------------------- |
| `voice_classifier_abi_smoke`    | ABI failure paths clear out-args and keep unavailable forwards fail-closed |
| `voice_emotion_classes_test`    | The 7-class vocabulary order is intact                          |
| `voice_speaker_distance_test`   | Cosine distance: identical=0, orthogonal=1, opposite=2          |
| `voice_mel_features_test`       | A 1 kHz sine wave peaks in the low-mid mel band                 |
| `voice_gguf_loader_test`        | Metadata validation accepts/rejects hand-rolled GGUF fixtures   |
| `voice_diarizer_parity_test`    | Pyannote diarizer parity when GGUF fixtures are available       |
| `voice_speaker_parity_test`     | WeSpeaker embedding parity when GGUF fixtures are available     |

## Layout

```
include/voice_classifier/voice_classifier.h  Public C ABI (frozen — see AGENTS.md).
src/voice_emotion.c                          Wav2Small emotion forward path.
src/voice_speaker.c                          WeSpeaker ResNet34-LM forward path.
src/voice_diarizer.c                         Pyannote-3 diarizer forward path.
src/voice_eot.c                              Audio EOT metadata validation; forward unavailable.
src/voice_emotion_classes.c                  Real: 7-class name table.
src/voice_speaker_distance.c                 Real: cosine distance helper.
src/voice_mel_features.c                     Real: shared log-mel front-end.
scripts/voice_emotion_to_gguf.py             Wav2Small converter.
scripts/voice_eot_to_gguf.py                 Skeleton converter.
scripts/voice_speaker_to_gguf.py             Skeleton converter.
scripts/voice_diarizer_to_gguf.py            Pyannote diarizer converter.
test/                                        ctest binaries; see table above.
CMakeLists.txt                               Builds libvoice_classifier + tests.
```

## License

Apache 2.0 — matches the suggested ECAPA-TDNN upstream
(`speechbrain/spkrec-ecapa-voxceleb`). The pinned upstream commits for
each head are recorded in the corresponding `scripts/voice_*_to_gguf.py`
file at conversion time.
