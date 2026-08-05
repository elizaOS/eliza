# `voice-classifier-cpp` native reference runtime

Standalone C runtime and GGUF converters for voice emotion, speaker embedding, diarization, and audio end-of-turn heads.

## Scope and status

This package provides a shared mel front-end, stable per-head ABIs, metadata-validated GGUF loading, scalar emotion/speaker/diarizer forwards, and test utilities. The audio end-of-turn head remains fail-closed: `voice_eot_score` returns `-ENOSYS` until a licensed upstream model and graph are pinned.

It is not the production TypeScript voice runtime. `@elizaos/plugin-local-inference` routes on-device voice features through fused `libelizainference` bindings; its speaker modules explicitly have no standalone `libvoice_classifier` fallback. Treat this directory as a native reference and conversion surface unless the single-runtime architecture is intentionally revised.

## Source map

```
include/voice_classifier/voice_classifier.h  stable public ABI
src/voice_mel_features.c                     shared 16 kHz log-mel front-end
src/voice_emotion.c                          seven-class emotion head
src/voice_speaker.c                          speaker embedding head
src/voice_diarizer.c                         diarization head
src/voice_eot.c                              fail-closed audio EOT boundary
src/voice_gguf_*.c                           GGUF metadata and tensor loading
src/voice_*_distance.c                       pure distance helpers
scripts/voice_*_to_gguf.py                   per-head converters
test/                                        ABI, metadata, utility, and parity tests
```

## Contracts

- Emotion output order is `neutral, happy, sad, angry, fear, disgust, surprise`; `voice_emotion_class_name` is canonical.
- Speaker output and distance dimensions must match the public header and the artifact metadata.
- `voice_speaker_distance` is cosine distance: identical vectors are 0, orthogonal vectors 1, opposite vectors 2.
- Each model uses a separate handle so runtimes load only the heads they need.
- Unknown checkpoints, wrong metadata, missing models, and unsupported heads fail explicitly.
- Do not mark a head available because its ABI compiles. Promotion requires a pinned distributable artifact, native/reference parity, and production binding coverage.

## Build and verification

```bash
cmake -B packages/native/plugins/voice-classifier-cpp/build -S packages/native/plugins/voice-classifier-cpp
cmake --build packages/native/plugins/voice-classifier-cpp/build -j
ctest --test-dir packages/native/plugins/voice-classifier-cpp/build --output-on-failure
```

Parity tests can require external GGUF/reference fixtures; run them with real artifacts for any affected head. Review probabilities, embeddings, diarization segments, error codes, and EOT unavailability by hand. Follow the repository-wide evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md).
