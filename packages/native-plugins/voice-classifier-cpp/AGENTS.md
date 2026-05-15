# voice-classifier-cpp — port plan

**ONNX deprecation status (J3 wave, 2026-05-15):** all three model heads in
this library (`voice_emotion_*`, `voice_speaker_*`, `voice_eot_*`) are stubs
that return `-ENOSYS`. The ONNX runtime paths in the resolved production code
remain active until these stubs are replaced with real ggml graph
implementations. Do NOT remove `onnxruntime-node` from
`plugin-local-inference/package.json` until all three heads are implemented.
See `.swarm/impl/J3-finalize.md §C` for the precise per-head next steps and
`.swarm/impl/I1-single-runtime.md §F` for the migration protocol.

Standalone C library that ports three small voice-side classifiers to
the elizaOS/llama.cpp fork's ggml dispatcher, replacing the ONNX
runtime path used today by:

- `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
  (Wav2Small / wav2vec2-emotion via onnxruntime-node);
- `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`
  (the `LiveKitTurnDetector` / `TurnsenseEotClassifier` text-side EOT
  classifiers — this library's EOT head is the **audio**-side semantic
  end-of-turn detector that pairs with them);
- `plugins/plugin-local-inference/src/services/voice/speaker/encoder.ts`
  (WeSpeaker ResNet34-LM via onnxruntime-node).

Today this is a **stub for the three model heads** plus three real
shared utilities (the emotion class-name table, the cosine-distance
helper, and the mel front-end). The stub TUs return `-ENOSYS` from
every model entry point; the real ports replace those TUs without
changing the ABI.

## Why one library, three heads

All three classifiers have the same shape: small input window of mono
16 kHz float PCM → small fixed-shape output. They share a log-mel
front-end (n_mels=80, n_fft=512, hop=160), the same audio plumbing,
the same threading contract, the same error model, and the same
diagnostic surface (`voice_classifier_active_backend`). Bundling them
as one library means:

- one CMake target, one set of compiler flags, one shared mel
  precomputation table;
- the eventual ggml dispatcher integration patches the fork once, and
  the three heads pick it up;
- the GGUF schema is per-head (one `.gguf` file per head) but the
  metadata-key conventions (`voice_emotion.variant`, etc.) follow the
  same pattern so the runtime can refuse mismatched bundles uniformly.

The three heads keep separate session handles so a runtime can load
only what it needs (e.g. mobile bundles often skip the speaker head).

## Per-head port plan

### Emotion (`voice_emotion_*`)

- **Output contract.** 7-class soft probabilities over the basic
  emotion set, in this exact order:

  ```
  0 = neutral
  1 = happy
  2 = sad
  3 = angry
  4 = fear
  5 = disgust
  6 = surprise
  ```

  This order is the contract for the GGUF conversion script, the
  runtime decode, and the TS binding. `voice_emotion_class_name(idx)`
  is the canonical accessor; the table lives in
  `src/voice_emotion_classes.c` and `test/voice_emotion_classes_test.c`
  enforces the order.

- **Suggested upstreams.** `harshit345/xlsr-wav2vec-speech-emotion-recognition`
  (CC-BY-NC research; would need a license-clean replacement before
  shipping) or — better for licensing — distill a small student from
  `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` plus a
  V-A-D → 7-class projection table. SpeechBrain
  (`speechbrain/emotion-recognition-wav2vec2-IEMOCAP`) is another
  Apache-2.0 option.

- **Model arch.** Whatever upstream we pick, the recommended target is
  a wav2vec2-style or HuBERT-style encoder + linear classification
  head, distilled small enough for CPU dispatch (~10-50 MB). The
  conversion script packs encoder weights + classifier head weights
  into one GGUF.

### End-of-turn (`voice_eot_*`)

- **Output contract.** A single P(end_of_turn) ∈ [0, 1].

- **Suggested upstreams.** `livekit/turn-detector` audio variants (if /
  when published) or `pipecat-ai/turn`. The text-side EOT classifiers
  in `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`
  (`LiveKitTurnDetector`, `TurnsenseEotClassifier`) operate on partial
  transcripts; this library's EOT head operates on **audio** and
  complements them — the runtime can fuse the two signals.

- **Model arch.** A small audio encoder (likely whisper-derived or a
  custom small RNN/Transformer trained on turn-completion labels) with
  a sigmoid head. The conversion script packs encoder + head as one
  GGUF.

### Speaker embedding (`voice_speaker_*`)

- **Output contract.** A 192-dim L2-normalized speaker embedding.
  Cosine distance via `voice_speaker_distance` (real implementation in
  `src/voice_speaker_distance.c`) — identical=0, orthogonal=1,
  anti-parallel=2.

- **Suggested upstream.** `speechbrain/spkrec-ecapa-voxceleb` —
  Apache-2.0, ECAPA-TDNN, 192-dim embedding — matches the output dim
  this header is pinned around. The legacy WeSpeaker ResNet34-LM
  encoder used today produces 256-dim embeddings; converting that to
  192-dim would require a re-projection layer or re-training, so the
  ECAPA upstream is the cleaner replacement target.

- **Model arch.** ECAPA-TDNN: TDNN backbone + attentive statistical
  pooling + linear projection to 192 dim. The conversion script packs
  backbone + projection.

## Shared front-end

- **`voice_mel_compute`.** Real implementation in
  `src/voice_mel_features.c`. Slaney mel scale, periodic Hann window,
  naive O(N²) DFT (acceptable for the small windows the three heads
  consume; a future pass can swap in pocketfft / kissfft behind the
  same signature). Used by `test/voice_mel_features_test.c` (1 kHz
  sine → peak in low-mid mel band).

- **No allocations on the hot path.** Per-frame scratch is stack-local;
  the mel filterbank + Hann window are precomputed once into static
  arrays via a lazy-init guarded by a flag.

## C ABI (frozen by `include/voice_classifier/voice_classifier.h`)

The stub implements every model entry point; the real ports must match
the ABI byte-for-byte. The shared utilities are real and stay as-is:

- `voice_emotion_class_name` — never NULL for valid indices, NULL for
  out-of-range; class order locked.
- `voice_speaker_distance` — cosine distance, real implementation,
  callable without an open session.
- `voice_mel_compute` / `voice_mel_frame_count` — real shared
  front-end.

Coordinate convention: every embedding / probability vector is in the
order documented in the header. Threading: reentrant against distinct
handles. Error codes: `errno`-style negatives. No silent fallbacks.

## GGUF conversion (one file per head)

Each head has its own conversion script under `scripts/`:

- `scripts/voice_emotion_to_gguf.py`
- `scripts/voice_eot_to_gguf.py`
- `scripts/voice_speaker_to_gguf.py`

All three follow the same skeleton (mirror of
`packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py` and
`packages/native-plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`):

- one writer per script, written-once metadata block, all tensors
  packed in a single pass;
- locked block-format constants at the top of the file (sample rate,
  mel parameters, output dim);
- pinned upstream commit recorded both in code and in the GGUF
  metadata key — runtime refuses unknown commits;
- `NotImplementedError` in every TODO block so a half-built converter
  cannot pass for working;
- per-head metadata key: `voice_emotion.variant`, `voice_eot.variant`,
  `voice_speaker.variant` — the runtime checks each.

## elizaOS/llama.cpp fork integration

The runtime calls live in this library; the fork only needs to expose
its ggml dispatcher and any custom op the heads need (none expected
for the first pass — wav2vec2 / ECAPA-TDNN building blocks are already
covered by `ggml_conv_1d`, `ggml_norm`, `ggml_mul_mat`).

1. Bring up the speaker head first — pure feed-forward TDNN, smallest
   surface, easiest parity test (compare 192-dim cosine distance
   against the SpeechBrain reference for a small enrollment set).
2. Bring up the emotion head next — wav2vec2 backbone is the
   heavy-weight piece; the classifier head is one `ggml_mul_mat`.
3. Bring up the EOT head last — depends on which upstream we land on;
   the turn-detection-from-audio research field is younger.
4. Add a `fork-integration/` directory if any new ggml ops or quant
   types are required (not expected). Mirror the layout used in
   `packages/native-plugins/polarquant-cpu/fork-integration/`.

## Replacement of the ONNX TS services

Once each `*_open` returns 0 and the parity tests in this directory
pass, the corresponding TS service swaps to the new ggml binding:

- `voice-emotion-classifier-ggml.ts` replaces `voice-emotion-classifier.ts`;
- `eot-classifier-ggml.ts` provides the audio-side EOT detector that
  pairs with the existing text-side classifiers in `eot-classifier.ts`;
- `speaker/encoder-ggml.ts` replaces `speaker/encoder.ts`.

The new TS files exist as **EXPERIMENTAL** bindings today (Phase 1).
Phase 2 wires them into the production pipeline once the ggml ports
land and parity gates pass.

## Build (today)

```
cmake -B packages/native-plugins/voice-classifier-cpp/build \
      -S packages/native-plugins/voice-classifier-cpp
cmake --build packages/native-plugins/voice-classifier-cpp/build -j
ctest --test-dir packages/native-plugins/voice-classifier-cpp/build --output-on-failure
```

Output: `libvoice_classifier.a` plus four test binaries:

- `voice_classifier_stub_smoke` — every model entry point still
  returns `-ENOSYS` and clears its out-parameters.
- `voice_emotion_classes_test` — the 7-class vocabulary order is
  intact; out-of-bounds returns NULL.
- `voice_speaker_distance_test` — identical=0, orthogonal=1,
  anti-parallel=2; zero-norm and NULL inputs degrade to 1.
- `voice_mel_features_test` — a 1 kHz sine produces a stable mel-band
  peak in the low-mid range and argument validation reports the
  documented error codes.

All four pass on the dev host today; that's the contract the port
preserves while it grows real implementations behind the same ABI.

## What's missing before the port is real

- Pinned upstream commits + recorded weight download recipes for each
  head.
- Real `discover_*_tensors`, `load_*`, and `write_gguf` implementations
  in the three `scripts/voice_*_to_gguf.py` files.
- ggml-backed model TUs (`src/voice_emotion_ggml.c`,
  `src/voice_eot_ggml.c`, `src/voice_speaker_ggml.c`) replacing the
  stub.
- Per-head parity test fixtures (small audio set + expected outputs
  from the upstream reference) wired into ctest.
- `fork-integration/` patches if any new ggml ops or quant types are
  needed (none expected for the first pass).
