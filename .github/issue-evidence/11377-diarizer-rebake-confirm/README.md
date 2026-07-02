# #11377 — diarizer re-bake confirm: full artifact × reader gate-order matrix

Re-bake + `speakeriso:real` confirm requested by the triage thread on #11377,
plus a standalone-reader probe that completes the 2×2 gate-order matrix. The
result **confirms the DER-1.000 mechanism (LSTM gate-order skew) but inverts
the triage's direction**: the published HF artifact is IOFC-packed and
*matches* the production fused lib; the stale side is the llama.cpp fork's
vendored `voice_diarizer.c` (IOFC reader) relative to
`packages/native/plugins/voice-classifier-cpp` (IFGO reader + converter).

## Environment

- Host: macOS arm64 (M4 Max), develop @ `82001b07534`.
- Fused lib: `libelizainference.dylib` (ABI v12) built from the
  `elizaOS/llama.cpp` fork at `2bdcef890` — exactly the commit develop pins for
  `plugins/plugin-local-inference/native/llama.cpp` (submodule clean).
  Its vendored `tools/omnivoice/src/voice-classifiers/voice_classifier/voice_diarizer.c`
  reads LSTM gates in **IOFC** order (fork commit `00f1fd5e3`, the original
  C-side #9460 fix; never re-synced after the reorder moved converter-side).
- Reference reader: `packages/native/plugins/voice-classifier-cpp` built at
  develop tip — reads **IFGO** (matches the current converter's
  `_reorder_iofc_to_ifgo`).
- ONNX source: ungated `onnx-community/pyannote-segmentation-3.0`
  (`onnx/model.onnx`, snapshot `733a93b6…`), no HF token.

## Artifacts (sha256 in `artifact-shas.txt`)

| artifact | packing | source | sha256 (8) |
| --- | --- | --- | --- |
| published `pyannote-segmentation-3.0.gguf` (HF `elizaos/eliza-1` `voice/diarizer/`, == manifest pin in `packages/shared/src/local-inference/voice-models.ts`, == live HF `x-linked-etag`) | **IOFC** | int8 ONNX (variant string `pyannote-segmentation-3.0-int8`) | `30983eba` |
| fresh bake, develop converter `voice_diarizer_to_gguf.py` | **IFGO** | fp32 ONNX | `7f4cd30f` |
| fresh bake, PR #11569 converter (adds `converter_epoch=2` + `lstm_gate_order="IFGO"`) | **IFGO** | fp32 ONNX | `100a5dbf` |
| probe bake, reorder disabled (raw ONNX order) | **IOFC** | fp32 ONNX | `d0d6c1e5` |

Tensor forensics (`published-tensor-forensics.txt`): every LSTM tensor of the
published GGUF matches the raw-ONNX **IOFC** packing within int8-dequant noise
(max |diff| ≤ 0.039; biases exact), and mismatches IFGO by ~8–12. All
non-LSTM tensors (SincNet, heads) match the current converter's layout.

## `speakeriso:real` matrix — fused lib (fork IOFC reader)

Full bench: 8-turn af_bella/am_michael Kokoro dialogue, 600 ms gaps, real
WeSpeaker encoder + real fused diarizer, CPU.

| lane | diarizer GGUF | DER | dropped-short | overlap probe | verdict |
| --- | --- | --- | --- | --- | --- |
| A | published `30983eba` (IOFC) | **0.209** | 358 ms | localSpeakerCount=2 | **PASS** |
| B | fresh develop bake `7f4cd30f` (IFGO) | **1.000** | 74 560 ms | localSpeakerCount=3, hasOverlap | FAIL — exact #11377 signature |
| C | probe bake `d0d6c1e5` (IOFC fp32) | **0.211** | 273 ms | localSpeakerCount=2 | PASS |
| D | PR #11569 bake `100a5dbf` (IFGO+epoch2) | **1.000** | 74 560 ms | localSpeakerCount=3, hasOverlap | FAIL (loads fine — current loader skips unknown keys) |

Encoder attribution is 6/6 (acc 1.000, margin 0.818) in every lane.

## Standalone probe — packages lib (IFGO reader), `diar_probe.c`

Single 5 s window (turn-01.wav, one speaker), per-frame label transitions:

| artifact | transitions / 293 frames | label histogram |
| --- | --- | --- |
| published (IOFC) | **159** — micro-segment flood, all 7 powerset classes lit | scrambled |
| fresh IFGO | **2** — silence→speaker, clean | correct |
| probe IOFC fp32 | **170** | scrambled |
| fresh IFGO+epoch2 | **2** | correct |

## Conclusion

- The DER-1.000 over-segmentation signature is **purely artifact×reader
  gate-order skew** — reproduced bit-for-bit in both skew directions; forward
  pass is correct on both readers when the packing matches.
- The published artifact + develop-pinned fused lib **agree (IOFC) and pass
  (DER 0.209)** — shipped desktop/mobile diarization is not broken by the
  published artifact today. int8-source cost is negligible (0.209 vs 0.211).
- **Republishing an IFGO re-bake before syncing the fork would flip every
  production fused lib to DER 1.000** (lane B/D is exactly that future).
  Required sequence: (1) sync the fork's vendored `voice_diarizer.c` to IFGO +
  port the #11569 fail-closed guard, (2) rebuild + repin fused libs,
  (3) republish the epoch-2 IFGO artifact + bump the manifest sha.

## Repro

```bash
# bake (no token; ONNX source is ungated)
python3 packages/native/plugins/voice-classifier-cpp/scripts/voice_diarizer_to_gguf.py \
  --output /tmp/pyannote-segmentation-3.0-fresh.gguf

# bench (per lane, swap ELIZA_DIARIZ_GGUF)
cd plugins/plugin-local-inference
ELIZA_INFERENCE_LIBRARY=<fused libelizainference> \
ELIZA_DIARIZ_GGUF=<artifact under test> \
ELIZA_SPEAKER_GGUF=<wespeaker-resnet34-lm.gguf> \
ELIZA_KOKORO_MODEL_DIR=<eliza-1 bundle>/tts/kokoro \
NODE_OPTIONS='--experimental-sqlite' bun scripts/speaker-isolation-real.ts

# standalone IFGO-reader probe
cmake -B build -S packages/native/plugins/voice-classifier-cpp && cmake --build build -j
cc -O2 -I packages/native/plugins/voice-classifier-cpp/include diar_probe.c \
   build/libvoice_classifier.a -o diar_probe -lm
./diar_probe <gguf> <16k-mono-pcm16.wav>
```

PR #11569 guard verified against real artifacts (its branch, built locally,
8/8 ctest green): published `30983eba` → rejected
(`stale GGUF converter epoch 0; need >= 2`), develop bake `7f4cd30f` →
rejected (no epoch key), epoch-2 bake `100a5dbf` → accepted, full tensor load
OK.
