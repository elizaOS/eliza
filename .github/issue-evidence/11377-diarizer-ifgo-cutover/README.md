# #11377 — diarizer IFGO cutover: reader sync + epoch-2 republish + pin bump

Executes the corrected operator plan from the #11377 rebake-confirm thread
(sibling bundle: `11377-diarizer-rebake-confirm/`). The DER-1.000 signature was
proven to be pure artifact × reader LSTM gate-order skew: the published HF
artifact was IOFC (epoch-less) matching the fork's vendored IOFC reader, while
the packages-side converter + reader had moved to IFGO (+ the #11569
fail-closed epoch guard). This change cuts everything over to IFGO in the
required order.

## What shipped

1. **Fork reader sync** — elizaOS/llama.cpp#40 (metadata parsing + contract
   test, MERGED) then elizaOS/llama.cpp#41 (MERGED): vendored
   `tools/omnivoice/.../voice_diarizer.c` flipped to **IFGO** gate unpack +
   ported the #11569 fail-closed guard (`converter_epoch >= 2` and
   `lstm_gate_order == "IFGO"` required; epoch-less/IOFC artifacts rejected
   loudly before tensor load). Contract test
   `omnivoice-test-diarizer-metadata` → `failures=0`.
2. **Epoch-2 IFGO artifact republished** — baked with the post-#11569
   `voice_diarizer_to_gguf.py` from ungated
   `onnx-community/pyannote-segmentation-3.0` (snapshot `733a93b6…`);
   **bit-identical to the rebake-confirm session's bake**
   (sha `100a5dbf…`, deterministic). Uploaded to HF `elizaos/eliza-1` as a NEW
   file `voice/diarizer/pyannote-segmentation-3.0-ifgo-epoch2.gguf`
   (HF commit `a89e5615ad616f7bf6c4982cd9eed2805b90370f`); the old
   `pyannote-segmentation-3.0.gguf` (`30983eba…`) is kept for older fused
   libs; `voice/diarizer/SHA256SUMS` added additively covering both.
   Round-trip download sha verified (`artifact-shas.txt`).
3. **This PR** — submodule pin bump to fork commit `dda200ab0` (descendant of
   develop's prior pin `58c0391eb`, so the #11612 Metal nil-pipeline +
   has_bfloat fixes are retained), diarizer `0.3.0` manifest entry in
   `packages/shared/src/local-inference/voice-models.ts`, probe-list updates,
   this evidence bundle.

## Environment

macOS arm64 (M4 Max), CPU+Metal. Fused `libelizainference.dylib` built from
fork commit `dda200ab0` (`cmake -DLLAMA_BUILD_OMNIVOICE=ON -DOMNIVOICE_SHARED=ON
-DCMAKE_BUILD_TYPE=Release`, target `elizainference`). Baseline lib built the
same way from `58c0391eb` (develop's prior pin). Real Kokoro corpus
(af_bella/am_michael, 8 turns, 600 ms gaps), real WeSpeaker encoder, real
fused diarizer — `speakeriso:real` (`scripts/speaker-isolation-real.ts`),
`SPEAKER_ISO_REQUIRE=1`.

## Results

| lane | lib | diarizer GGUF | result |
| --- | --- | --- | --- |
| fixed pairing | IFGO lib (`dda200ab0`) | epoch-2 IFGO `100a5dbf` | **DER 0.211**, attribution 6/6 (margin 0.818), overlap probe localSpeakerCount=2 — **PASS** (`speakeriso-fixed-pairing.txt`) |
| guard | IFGO lib (`dda200ab0`) | published IOFC `30983eba` | **REJECTED LOUDLY**: `[voice_diarizer] stale GGUF converter epoch 0; need >= 2 with LSTM gates packed as IFGO` → typed `VoiceLifecycleError` rc=-22, bench exit 1 — no silent scramble (`speakeriso-guard-rejects-published-iofc.txt`) |
| kokoro smoke | IFGO lib | — | synth OK: 91800 samples @24 kHz, envelope-cv 1.229 (real speech). TTFA 6230–6894 ms exceeds the 700 ms mobile budget — **pre-existing on the baseline pin lib too (4876 ms, same cold-load failure), not a regression**; audio metrics identical across libs (`kokoro-smoke-new-lib.txt` vs `kokoro-smoke-baseline-pin-lib.txt`). Diff `58c0391eb..dda200ab0` touches only `tools/omnivoice` voice-classifier files — zero Kokoro code. |
| asr smoke | IFGO lib | — | **PASS**, real transcript in 861 ms over Metal (`asr-smoke-new-lib-tail.txt`) |

DER matrix vs the rebake-confirm bundle: skewed pairings 1.000 → fixed IFGO
pairing **0.211** (identical to the IOFC/IOFC control lanes A/C at 0.209/0.211
— the forward pass is equivalent; the skew was the only bug). The overlap
probe deliberately plays both voices simultaneously; `localSpeakerCount=2,
hasOverlap=true` matches passing lanes A/C exactly (the failure signature was
`localSpeakerCount=3`).

## Repro

```bash
# bake (deterministic; no token — ONNX source is ungated)
python3 packages/native/plugins/voice-classifier-cpp/scripts/voice_diarizer_to_gguf.py \
  --output /tmp/pyannote-segmentation-3.0-ifgo-epoch2.gguf   # sha 100a5dbf…

# fused lib from the pinned fork commit
git -C <llama.cpp fork> checkout dda200ab0
cmake -B build-fused -S . -DLLAMA_BUILD_OMNIVOICE=ON -DOMNIVOICE_SHARED=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_TOOLS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-fused --target elizainference -j

# bench (fixed pairing → PASS; swap ELIZA_DIARIZ_GGUF to the published
# 30983eba artifact → loud guard rejection)
cd plugins/plugin-local-inference
SPEAKER_ISO_REQUIRE=1 \
ELIZA_INFERENCE_LIBRARY=<build-fused>/bin/libelizainference.dylib \
ELIZA_DIARIZ_GGUF=<epoch-2 bake> \
ELIZA_SPEAKER_GGUF=<wespeaker-resnet34-lm.gguf> \
ELIZA_KOKORO_MODEL_DIR=<eliza-1 bundle>/tts/kokoro \
NODE_OPTIONS='--experimental-sqlite' bun scripts/speaker-isolation-real.ts

# fork contract test
cmake --build build-11377 --target omnivoice-test-diarizer-metadata -j
./build-11377/bin/omnivoice-test-diarizer-metadata   # failures=0
```
