# G-emotion — Wav2Small distillation + HF publish

**Owner:** G-emotion (Voice Wave 2 closing)
**Branch:** `develop`
**Status:** **eval gate missed (0.319 vs 0.35); HF push NOT performed**

## TL;DR

- End-to-end Wav2Small distillation pipeline runs cleanly on the
  RTX 5080 Laptop in <10 min wall (full v4 run, 100 epochs).
- Student trains to **71,666 params** (within 5 % of the 72,256
  target), exports cleanly to INT8 ONNX with dynamic sequence length
  (1 s / 4 s / 8 s all verified), runs at ~5 ms/inference on CPU.
- Test macro-F1 on the **V-A-D projection (shipped runtime metric)**:
  **0.319**, vs gate 0.35 — short by 0.031.
- Test macro-F1 on the **auxiliary classifier head (training-only)**:
  **0.355** — would pass, but is dropped at export. Not the shipped
  metric.
- Per the brief: "If you can't hit the gate, document the highest
  achieved and propose next-step changes; do not silently push a
  sub-gate artifact." **No HF upload performed.** Local artifact
  available at
  `packages/training/out/emotion-wav2small-v1/wav2small-msp-dim-int8.onnx`
  (516,877 bytes, sha256
  `2fcde4aa2a6881b0e7407a3a706fab1889b69233139ee10b8669795b02b06efc`).

## Hardware + corpus

- RTX 5080 Laptop (Blackwell sm_120, 16 GB), CUDA 12.8.
- Disk at 99 % (33 GB free) — limited cache headroom, no Nebius
  escalation needed: full run finished in ~10 min.
- Corpus: **`xbgoose/ravdess`** (HF parquet format).
  - `nateraw/iemocap`, `speechbrain/MELD-Emotion-Recognition`, all
    common CREMA-D mirrors return 404.
  - `myleslinder/crema-d` uses a legacy `crema-d.py` loader the
    current `datasets` library refuses to run.
  - `xbgoose/ravdess` resolves cleanly. 1,440 clips, 24 actors,
    8 emotional categories, 48 kHz speech-and-song.
- WAV bytes are decoded directly from the parquet (no torchcodec /
  ffmpeg) and resampled to 16 kHz with librosa. After dropping
  `disgust` (no mapping): **1,248 clips** split 998/124/126
  train/val/test (deterministic seed=7).

Emotion mapping (RAVDESS → `EXPRESSIVE_EMOTION_TAGS`):

```
happy → happy        sad → sad           angry → angry
calm → calm          fearful → nervous   surprised → excited
neutral → calm       disgust → DROP
```

`whisper` is absent from RAVDESS, so per-class F1 for that class is
always 0 and macro-F1 is bounded by 6/7 ≈ 0.857.

## Pipeline

`packages/training/scripts/emotion/run_distill_ravdess.py` —
end-to-end orchestrator that:

1. Reads RAVDESS parquet shards (decoded from raw WAV bytes), resamples
   to 16 kHz mono.
2. Runs the audeering teacher (`Wav2Vec2`-based `EmotionModel`,
   custom-class as documented in upstream README) on each clip padded
   to one 8-sec window. V-A-D outputs cached in `teacher-cache.json`
   so re-runs skip the teacher cost (34 s → 0 s wall).
3. Trains the student with joint loss
   `vad_weight * MSE(V-A-D) + cls_weight * weighted-CE(7-class)`.
   APOLLO-Mini optimizer (rank-1, tensor-wise — required by
   `packages/training/AGENTS.md §1`), cosine schedule with 5 % linear
   warmup.
4. Eval gate: macro-F1 of the **runtime V-A-D projection** (mirrors
   `voice-emotion-classifier.ts:projectVadToExpressiveEmotion` exactly).
5. Exports INT8 ONNX with dynamic sequence length and
   `expressive_emotion_tags` metadata; smoke-roundtrips at 1 s / 4 s
   / 8 s inputs.
6. Writes provenance JSON.

`packages/training/scripts/emotion/publish_wav2small.py` is ready but
**not executed**.
`packages/training/scripts/emotion/update_voice_emotion_registry.py`
is ready but **not executed** (no HF revision to record).

## Teacher load fixes (transformers 5.x compatibility)

The audeering teacher checkpoint trips three modern-transformers
strict-validation paths. Fixes in `distill_wav2small.py:load_teacher`:

1. **Swap `Wav2Vec2Processor` → `Wav2Vec2FeatureExtractor`.**
   The audeering repo has an empty `vocab.json` (regression model;
   no tokenizer), and `Wav2Vec2Processor.from_pretrained` always
   tries to build a tokenizer.
2. **Patch `vocab_size: null → 32` in the config dict.**
   The strict-typing dataclass refuses `null`. The regression head
   ignores vocab_size; we need a legal int.
3. **Declare `all_tied_weights_keys = {}` on `EmotionModel`.**
   `_finalize_model_loading` requires this attribute on every
   `Wav2Vec2PreTrainedModel` subclass.

The audeering teacher's output order is `(arousal, dominance, valence)`
per the upstream config's `id2label`; we re-order to `(V, A, D)` so
the student head's contract matches.

## LogMel front-end replaced

The shipped `distill_wav2small.py` had a `LogMel` class that was a
Conv1d with **random Kaiming init** — not a real log-mel filterbank.
Replaced with a **frozen DFT-conv + librosa mel matrix**:

- Two parallel frozen `Conv1d`s carry the cos/sin DFT basis × Hann
  window.
- `power = real² + imag²` per frequency bin.
- A frozen `[80, 201]` librosa mel matrix maps power-spectrum bins to
  mel bands.
- `log(mel.clamp_min(1e-6))` for log compression.

Matches `torch.stft + MelSpectrogram` to ~1e-5. Pure Conv1d + einsum +
log — exports cleanly to ONNX opset 17 (`torch.stft` itself does not).
Trainable parameter count unchanged at **71,666** (front-end is
buffers, not parameters).

## V-A-D target calibration ("centroids" mode)

Discovery: the audeering teacher's V-A-D distribution on emotional
speech clusters around `V ≈ 0.35`, `A ≈ 0.68`, `D ≈ 0.69` —
incompatible with the runtime projection table in
`voice-emotion-classifier.ts`, which is calibrated against V-A-D
centred at 0.5 spanning ~[0, 1]. **Oracle macro-F1 with raw teacher
V-A-D + the runtime projection caps at 0.155**, regardless of how
well the student fits the teacher.

Switched to **per-class V-A-D centroid targets** — V-A-D triples
chosen so each one maximally activates exactly one class under the
runtime projection:

```
happy   = (1.00, 0.70, 0.50)
sad     = (0.00, 0.00, 0.50)
angry   = (0.00, 1.00, 1.00)
nervous = (0.00, 1.00, 0.00)
calm    = (1.00, 0.00, 0.50)
excited = (0.85, 1.00, 0.50)
whisper = (0.50, 0.00, 0.00)
```

All seven verified to project uniquely to their own tag. The student
learns V-A-D values that the runtime correctly classifies; the
shipped ONNX contract (3-dim V-A-D output) is unchanged.

## ONNX export fix

The legacy TorchScript exporter (`dynamo=False`) bakes the dummy
input's sequence length into the multi-head-attention Reshape ops.
A model exported with an 8 s dummy refused to run on 4 s or 1 s
inputs, but the runtime adapter accepts 1.0 s ≤ pcm.length ≤
`WAV2SMALL_MAX_SAMPLES`. Switched to `dynamo=True` (torch.export
backend), with a value_info clear before quantization (the dynamo
exporter sometimes leaves stale shape annotations that
onnxruntime's INT8 quantizer rejects).

Verified: 1 / 2 / 3 / 4 / 6 / 8-second inputs all run cleanly through
the exported INT8 graph. Batch fixed at 1 (matches runtime).

## Final results (run v4)

- **Param count:** 71,666 (within 5 % of 72,256 target — passes the
  `assert_student_param_budget` gate).
- **ONNX size:** 516,877 bytes INT8 (vs 122,880-byte placeholder).
- **ONNX sha256:** `2fcde4aa2a6881b0e7407a3a706fab1889b69233139ee10b8669795b02b06efc`.
- **Training wall-clock:** 9 min 38 s (full run, 100 epochs, cache hit
  after first run).
- **GPU utilisation:** ~95 % peak, ~7 GB VRAM during training.

### Best-val checkpoint (epoch 60) — test split:

| Metric                  | Value | Gate | Pass? |
|-------------------------|-------|------|-------|
| `mse_vad`               | 0.1350 | — | — |
| `macro_f1` (V-A-D proj) | **0.3192** | 0.35 | **MISS by 0.031** |
| `macro_f1_aux`          | 0.3550 | (not gated) | n/a |
| `accuracy` (V-A-D proj) | 0.4603 | — | — |
| `accuracy_aux`          | 0.4841 | — | — |
| `abstain_rate`          | 0.024 | — | — |

(Best val was 0.3455 at epoch 60; test set lands at 0.3192.)

Confusion (from epoch 60 — sample of 50 test clips):

```
gold=happy(0)    → preds: excited 4, calm 2
gold=sad(1)      → preds: excited 4, calm 3, abstain 2
gold=angry(2)    → preds: angry 6, calm 2, excited 2, abstain 1
gold=nervous(3)  → preds: angry 2, excited 2, calm 1, abstain 1
gold=calm(4)     → preds: calm 9, abstain 1
gold=excited(5)  → preds: calm 4, excited 3, abstain 1
```

`calm` is reliable (9/10). `angry` is OK (6/11). The other classes
collapse into excited/calm clusters — the model can't acoustically
separate happy/sad/nervous/excited in V-A-D space with this corpus
and capacity.

## Decision: no HF push

The brief is explicit:

> "If you can't hit the gate, document the highest achieved and propose
> next-step changes; **do not silently push a sub-gate artifact**."

We hit 0.319 vs the 0.35 gate on the shipped V-A-D-projection metric.
The HF repo `elizaos/eliza-1-voice-emotion` is untouched. The local
ONNX is available for diagnostic inspection at
`packages/training/out/emotion-wav2small-v1/wav2small-msp-dim-int8.onnx`
but is **not** registered in the manifest registry and is **not**
published.

## Proposed next-step changes (highest-impact first)

1. **Larger corpus.** RAVDESS has only 24 actors × ~150 clips/class.
   The Wav2Small paper trains on MSP-Podcast (40k+ utterances) and
   MELD/IEMOCAP supplements. Adding CREMA-D (7k clips, 6 emotions)
   would ~6× the training data — likely the single highest-impact
   change. Currently blocked by the `myleslinder/crema-d` legacy
   loader; needs a parquet mirror or `--trust-remote-code` bypass.

2. **Re-calibrate the runtime projection table for the audeering
   teacher's V-A-D distribution.** The current table assumes V-A-D
   centred at 0.5 spanning ~[0, 1]; the audeering teacher emits
   V ≈ 0.35, A ≈ 0.68, D ≈ 0.69. Recalibrating the table would let
   us train the student to match the teacher's V-A-D directly (with
   higher fidelity than centroid targets), and remove an entire
   class of distribution-mismatch errors. Out of this sub-agent's
   scope — runtime change.

3. **Data augmentation.** SpecAugment + room-impulse + SNR-noise via
   `audiomentations` is stock recipe — would help generalisation on
   RAVDESS's narrow 24-actor space. Easy follow-up: ~30 lines.

4. **Ship the aux classifier head instead of V-A-D.** The aux head
   hit 0.3550 on the test split, which would pass the gate. The
   trade-off: the runtime ONNX contract changes from `vad: [B,3]`
   to `cls_logits: [B,7]`, and the runtime adapter's projection
   table is bypassed. Cleaner classifier interface but a bigger
   integration change.

5. **Knowledge distillation via the audeering teacher's
   `hidden_states`.** Instead of distilling only the 3-d V-A-D
   output, distil the 1024-d penultimate features into the student's
   56-d transformer hidden state with an L2/cosine loss. Gives the
   student much richer supervision and is the standard wav2small
   recipe. Currently we only use the 3-d teacher output.

Recommended order: 1 + 3 first (data/aug), 5 if still short, 4 as
fallback, 2 as a parallel runtime PR.

## Files produced

- `packages/training/scripts/emotion/run_distill_ravdess.py` — end-to-end
  orchestrator.
- `packages/training/scripts/emotion/publish_wav2small.py` — HF push
  orchestrator (not executed).
- `packages/training/scripts/emotion/update_voice_emotion_registry.py`
  — in-place updater for the placeholder 0.1.0 registry entry (not
  executed).
- `packages/training/scripts/emotion/distill_wav2small.py` — patched
  to support the audeering teacher under transformers 5.x and to
  emit a real (frozen) log-mel front-end + dynamic-shape ONNX export.
- `packages/training/out/emotion-wav2small-v1/wav2small-msp-dim-int8.onnx`
  — final diagnostic INT8 artifact, 516,877 bytes.
- `packages/training/out/emotion-wav2small-v1/wav2small-msp-dim-int8.json`
  — provenance sidecar.
- `packages/training/out/emotion-wav2small-v1/best.pt` — best-val
  PyTorch checkpoint (epoch 60, `val_f1_proj=0.3455`).
- `packages/training/out/emotion-wav2small-v1/teacher-cache.json` —
  cached audeering V-A-D outputs (re-use across retrains).
- `packages/training/out/emotion-wav2small-v1/run-v4.log` — full run log.

## Verification

```bash
python3 -m pytest packages/training/scripts/emotion/test_distill_wav2small.py -v
# 19 passed in 0.82s — green throughout.
```

`bun --filter @elizaos/plugin-local-inference test -- voice-emotion`
and `bun run verify` weren't re-run because we did not modify the TS
runtime adapter, and the registry / manifest were untouched (no
publish).

## Commits

```
69fa933e89  wip(G-emotion): add RAVDESS orchestrator + fix teacher load for transformers 5.x
3346590d4b  wip(G-emotion): teach distill_wav2small loader to use audeering custom EmotionModel
6b2180b9ff  wip(G-emotion): proper STFT/mel front-end + V-A-D-projection eval
ce1ea1adc4  wip(G-emotion): centroid V-A-D targets + registry-update tool
94054b2024  wip(G-emotion): switch ONNX export to dynamo for dynamic seq lengths
```

All on `develop`, pushed.
