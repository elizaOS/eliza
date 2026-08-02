# `wakeword-cpp` native runtime

Standalone C implementation of the three-stage openWakeWord pipeline over GGUF artifacts.

## Role

This package provides a frozen C ABI and scalar runtime for streaming melspectrogram, embedding, and classifier stages. `@elizaos/plugin-local-inference` can load it through `src/services/voice/wake-word-ggml.ts`, but the resolver in `wake-word.ts` tries the fused `libelizainference` wake-word ABI first and uses this standalone library only when the fused build lacks that capability and the library plus all three GGUFs are present.

Do not reverse that order or turn a missing model into a zero-confidence success. Both paths implement the same `WakeWordModel` contract and must fail observably when no real backend is available.

## Artifact and ABI contract

A standalone session loads three matching GGUFs:

- `<head>.melspec.gguf`
- `<head>.embedding.gguf`
- `<head>.classifier.gguf`

`scripts/wakeword_to_gguf.py` converts the pinned openWakeWord artifacts and records `wakeword.upstream_commit`. The runtime rejects mismatched pins, dimensions, stages, or metadata.

`include/wakeword/wakeword.h` defines session open, arbitrary-chunk 16 kHz PCM processing, threshold configuration, close, and backend diagnostics. Session state carries partial PCM, mel frames, and embedding history until the classifier has enough context.

## Layout

```
include/wakeword/wakeword.h   stable public ABI
src/wakeword_runtime.c        session, GGUF loading, and model stages
src/wakeword_melspec.c        streaming spectral front end
src/wakeword_window.c         sliding-window framing
scripts/wakeword_to_gguf.py   pinned converter
test/wakeword_*               ABI, spectral, framing, runtime, score, and parity tests
```

The model is fixed at 16 kHz mono float PCM. Preserve the FFT/hop sizes, mel and embedding dimensions, head window, normalization, and upstream metadata as one coordinated artifact contract.

## Build and verification

```bash
cmake -B packages/native/plugins/wakeword-cpp/build -S packages/native/plugins/wakeword-cpp
cmake --build packages/native/plugins/wakeword-cpp/build -j
ctest --test-dir packages/native/plugins/wakeword-cpp/build --output-on-failure
```

Runtime and parity tests require the real GGUF and reference artifacts. A skipped parity lane does not establish readiness. For integration changes, also run the parent plugin's fused-first resolver against real positive, negative, near-match, silence, and noisy audio.

## Constraints

- Distinct handles are reentrant; shared handles require caller synchronization.
- Missing/corrupt artifacts and invalid PCM return explicit errors.
- Early frames before sufficient context may have no classifier decision; callers must distinguish warm-up from a true negative.
- Reset semantics require closing/reopening unless the ABI is deliberately extended and verified.
- Backend/SIMD upgrades remain behind the public ABI.
- Threshold tuning needs reviewed false-accept and false-reject evidence, not synthetic tones alone.

Follow the repository-wide verification standard in the [root CLAUDE.md](../../../../CLAUDE.md). Review score traces, latency, CPU use, resolver selection, and failure behavior.
