# Voice Quality Metrics — canonical reference

This is the canonical reference for every metric Voice Wave 2 uses to
gate a model publish. It pins each metric's definition, valid range,
the gate threshold currently checked in code, the model dependency
that produces it, and a citation back into the source file that owns
the computation.

The metrics in this document gate **three** publish surfaces:

- Kokoro voice clones (`packages/training/scripts/kokoro/eval_kokoro.py`).
- Turn-detector LoRA fine-tunes (`packages/training/scripts/turn_detector/eval_turn_detector.py`).
- Wav2Small emotion-classifier distillation (`packages/training/scripts/emotion/distill_wav2small.py`).

This page exists because the Q1 metric audit (see
`.swarm/impl/Q1-quality.md`) found that two of the four Kokoro
metrics were broken at the model + audio-handling layer. The audit
fixed the code; this page is the durable contract that should keep
new metric drift from sneaking back in. If a number on this page
disagrees with the code, the code is the source of truth — file an
issue against this doc.

## Scope

In scope:

- UTMOS (synthesis quality)
- WER (intelligibility round-trip)
- SpkSim (speaker similarity)
- RTF (real-time factor)
- TurnDetectorF1 (end-of-utterance detection)
- EmotionClassifier macro-F1 (7-class emotion projection)

Out of scope:

- Latency / VRAM budgets — owned by the memory-arbiter docs.
- Provenance / license gates — owned by the publishing pipeline.

---

## UTMOS

**Definition.** UTokyo-SaruLab MOS: a learned non-intrusive predictor
of subjective Mean Opinion Score for synthesized speech. Returns a
single scalar in the MOS scale.

**Valid range.** `[1.0, 5.0]`. A genuinely clean human-quality TTS
typically scores in the 3.8–4.4 band; below 3.0 indicates audible
artifacts.

**Gate.** `utmos_min ≥ 3.8` for production publishes
(`packages/training/scripts/kokoro/configs/base.yaml:61` and the
sam config at line 51). The same threshold is reused across all
Kokoro voice variants.

**Model dependency.** Two paths are tried in order:

1. **Primary — `utmos` PyPI package**
   (https://pypi.org/project/utmos/, ≥0.1.0). The canonical SaruLab
   UTMOS checkpoint. Returns MOS directly.
2. **Fallback — `torchaudio.pipelines.SQUIM_SUBJECTIVE`**
   (https://pytorch.org/audio/main/generated/torchaudio.pipelines.SquimSubjectivePipeline.html).
   A non-matching-reference MOS predictor; consumes one *non-matching
   clean reference clip* alongside the target audio. Runs at 16 kHz
   (`SQUIM_SUBJECTIVE.sample_rate == 16000`). Returns MOS in the same
   `[1, 5]` band.

**Removed fallback.** `SQUIM_OBJECTIVE` is **not** used. It returns
`(STOI, PESQ, SI-SDR)` — the third tensor is signal-to-distortion
ratio in dB, not MOS, and was the source of the `utmos = -7.91`
report in I7's first eval. See Q1-quality §1.1.

**Citation.** `packages/training/scripts/kokoro/eval_kokoro.py:232-277`
(model selection, sample-rate handling, fallback prose).

---

## WER (Word Error Rate)

**Definition.** Levenshtein edit distance between the reference
prompt and Whisper's transcript of the synthesized audio, normalized
by reference token count. `WER = (substitutions + insertions +
deletions) / |ref_tokens|`.

**Valid range.** `[0.0, +∞)`. In practice clean TTS lands ≤ 0.10,
degraded TTS climbs into the 0.3–0.6 band. WER can exceed 1.0 in
pathological cases (Whisper hallucinates many tokens against a short
reference).

**Gate.** `wer_max ≤ 0.08` for production publishes
(`packages/training/scripts/kokoro/configs/base.yaml:62`).

**Model dependency.** OpenAI Whisper (`large-v3` on CUDA,
`small` on CPU/MPS). Required input sample rate: **16 kHz**
(`whisper.audio.log_mel_spectrogram` docstring). Kokoro emits 24 kHz
audio — the eval harness resamples to 16 kHz before transcription.

**Text normalization.** Before edit-distance both reference and
hypothesis go through `_normalize_text_for_wer`:

- lowercase,
- strip punctuation including unicode quotes, em-dashes, and CJK
  punctuation, **except apostrophes inside contractions** ("don't",
  "I'm" stay one token to match Whisper's tokenization),
- collapse whitespace.

This matches `jiwer`'s default `RemovePunctuation + ToLowerCase`
behaviour and avoids penalizing the model for punctuation it never
produced. Pre-Q1 fix this added 10–30% phantom WER on short clips.

**Citation.** `packages/training/scripts/kokoro/eval_kokoro.py:282`
(`asr_sr = 16000`), `:367` (`_normalize_text_for_wer`), `:382`
(`_word_error_rate`).

---

## SpkSim (Speaker Similarity)

**Definition.** Cosine similarity between two 192-dim ECAPA-TDNN
speaker embeddings: the embedding of the synthesized clip and the
embedding of the corresponding reference clip from the val set.
Averaged across the val set.

**Valid range.** `[-1.0, +1.0]`. Same speaker, same recording
conditions: 0.6–0.9. Same speaker, different conditions: 0.4–0.7.
Different speakers: typically below 0.3.

**Gate.** `speaker_similarity_min ≥ 0.65` for production publishes
(`packages/training/scripts/kokoro/configs/base.yaml:63`). Small-corpus
voice clones (the same config) relax this to `0.55`
(`packages/training/scripts/kokoro/configs/kokoro_same.yaml:53`)
because the held-out val set is only ~5 clips and ECAPA cosine
variance is high at that sample size — see I7-kokoro §3.

The baseline comparison block (`comparison.beatsBaseline`) requires
`spkSimDelta ≥ +0.05` independent of the absolute gate.

**Model dependency.** SpeechBrain
`speechbrain/spkrec-ecapa-voxceleb` (ECAPA-TDNN trained on
VoxCeleb 1+2). Required input sample rate: **16 kHz**. Kokoro emits
24 kHz; both synth and reference are resampled to 16 kHz before
`encode_batch`.

**Runtime parallel.** The TS runtime uses WeSpeaker ResNet34-LM
(int8 ONNX) for speaker matching, not ECAPA. The eval harness uses
ECAPA because it is the academic standard with a 16 kHz contract
that lines up with Whisper. Embedding-space parity between the two
encoders is a separate question; the runtime never compares its
embeddings against the eval-harness embeddings.

**Citation.** `packages/training/scripts/kokoro/eval_kokoro.py:225-230`
(model load), `:287` (`spk_sr = 16000`), `:316-319` (cosine
computation).

---

## RTF (Real-Time Factor)

**Definition.** `RTF = total_synth_audio_seconds / total_wall_clock_seconds`
across the eval prompts. **Higher is better** — RTF ≥ 1.0 means
faster than realtime, RTF = 100 means 100× faster than realtime.

This is the inverse of the academic "RTF" convention used in some
papers (`wall / audio` — lower-is-better). We chose throughput
direction so a positive `rtfDelta` always means "the candidate is
faster".

**Valid range.** `[0.0, +∞)`. Kokoro 82M on a recent CUDA GPU lands
~100×; on M-series Apple Silicon ~10–20×; on CPU ~1–5×.

**Gate.** `rtf_min ≥ 5.0` for production publishes
(`packages/training/scripts/kokoro/configs/base.yaml:64`). Devices
below 5× realtime are not eligible to ship this voice as a default —
the runtime falls back to a lighter model.

**Model dependency.** None — this is wall-clock measurement around
the synth call. Implementation in
`_measure_rtf(synth_fn, prompts, device)`. Cold-start cost is
amortized by running the same prompts that were already used for the
quality metrics (warm pipeline state).

**Citation.** `packages/training/scripts/kokoro/eval_kokoro.py:146-157`.

---

## TurnDetectorF1

**Definition.** Binary F1 score for the end-of-utterance (EOU) class
on the held-out test split. Treats the EOU token as positive and all
other tokens as negative.

`F1 = 2 * precision * recall / (precision + recall)`.

**Valid range.** `[0.0, 1.0]`.

**Gate.** `F1 ≥ 0.85` and `meanLatencyMs ≤ 30`
(`packages/training/scripts/turn_detector/eval_turn_detector.py:31`,
`packages/training/scripts/turn_detector/finetune_turn_detector.py:52`).
Both must pass — a model can hit 0.85 F1 but be too slow for
realtime gating, or hit the latency budget with poor accuracy.

**Model dependency.** SmolLM-360M (or successor) LoRA-fine-tuned on
an EOU corpus. Inference path runs on the device CPU/GPU at runtime;
the eval harness mirrors that path.

**Citation.** `packages/training/scripts/turn_detector/eval_turn_detector.py:31`,
`packages/training/scripts/turn_detector/README.md:22`.

---

## EmotionClassifier macro-F1 (Wav2Small)

**Definition.** Per-class F1 averaged uniformly across the 7-class
`ExpressiveEmotion` projection (neutral, happy, sad, angry, fearful,
surprised, disgusted). The student head's continuous V-A-D output is
projected into the discrete tag set and compared against ground-truth
labels.

`macroF1 = (1/K) * Σ_k F1_k` where `K = 7`.

**Valid range.** `[0.0, 1.0]`.

**Gate.** Two thresholds, both required to ship:

- `macro_f1_meld ≥ 0.35` — MELD test set
  (low because MELD is conversational + noisy and the literature
  ceiling is in the 0.45–0.55 band).
- `macro_f1_iemocap ≥ 0.50` — IEMOCAP test set
  (clean studio audio, higher ceiling).

Source: `packages/benchmarks/voice-emotion/elizaos_voice_emotion/runner.py:77`
(MELD bar) and the distill provenance at
`packages/training/scripts/emotion/distill_wav2small.py:145-146`.

**Model dependency.** Wav2Small INT8 ONNX, student-distilled from
the audeering `wav2vec2-large-robust-12-ft-emotion-msp-dim` teacher.
Required input sample rate: **16 kHz** (the Wav2Small log-mel front
end is fixed at this rate). See `WAV2SMALL_SAMPLE_RATE = 16_000` in
`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts:51`.

**Citation.** Distill spec at
`packages/training/scripts/emotion/distill_wav2small.py:60-70`;
runtime contract at
`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts:42-55`.

---

## Sample rate contract

Every model that consumes audio in Voice Wave 2 has a fixed required
sample rate. This subsection is the durable record of what feeds
what, so future changes do not silently regress the way I7's first
eval did.

| Consumer | Required SR | Source contract |
| --- | --- | --- |
| Kokoro decoder output | 24 kHz | `packages/training/scripts/kokoro/configs/base.yaml:9` (`sample_rate: 24000`); also returned by `synth(...)` in `eval_kokoro.py:216`. |
| Whisper (`small`, `large-v3`) | 16 kHz | `whisper.audio.log_mel_spectrogram` docstring; pinned in `eval_kokoro.py:282` (`asr_sr = 16000`). |
| ECAPA-TDNN (`speechbrain/spkrec-ecapa-voxceleb`) | 16 kHz | VoxCeleb training config; pinned in `eval_kokoro.py:287` (`spk_sr = 16000`). |
| SQUIM_SUBJECTIVE | 16 kHz | `torchaudio.pipelines.SQUIM_SUBJECTIVE.sample_rate == 16000`; read at runtime in `eval_kokoro.py:260` (`squim_sr = int(SQUIM_SUBJECTIVE.sample_rate)`). |
| utmos (PyPI) | accepts a `sample_rate` arg, internally resamples | `eval_kokoro.py:250-251` passes the synth-native rate directly. |
| WeSpeaker ResNet34-LM (runtime speaker encoder) | 16 kHz | `plugins/plugin-local-inference/src/services/voice/speaker/encoder.ts:48` (`WESPEAKER_SAMPLE_RATE = 16_000`). |
| Wav2Small (runtime emotion classifier) | 16 kHz | `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts:51` (`WAV2SMALL_SAMPLE_RATE = 16_000`). |

**Resample helper.** `eval_kokoro._resample_audio(audio, src_sr=...,
dst_sr=...)` (`packages/training/scripts/kokoro/eval_kokoro.py:407`).
Identity-returns when rates match, otherwise calls
`librosa.resample` with the default `kaiser_best` window. The eval
harness is intentionally slow + accurate here — this is offline
quality measurement, not realtime synthesis.

**Mandatory invariant.** Anywhere a Python numpy waveform is handed
to a 16-kHz model, the caller MUST go through `_resample_audio` (or
equivalent) first. The Q1 audit traced this — only the eval harness
had the bug; the TS runtime side already mediates SR on every audio
hand-off.

---

## Baseline comparison sign conventions

The kokoro publish path also gates on `comparison.beatsBaseline`,
which is a per-metric sign check against a baseline `eval.json`:

| Delta | Direction for "candidate beats baseline" |
| --- | --- |
| `utmosDelta = candidate.utmos - baseline.utmos` | `≥ 0` (higher MOS is better) |
| `werDelta = candidate.wer - baseline.wer` | `≤ 0` (lower WER is better) |
| `speakerSimDelta = candidate.spkSim - baseline.spkSim` | `≥ +0.05` (positive **and** beats the 0.05 noise floor) |
| `rtfDelta = candidate.rtf - baseline.rtf` | not gated; positive = faster |

`beatsBaseline = utmosΔ ≥ 0 && werΔ ≤ 0 && spkSimΔ ≥ 0.05`. The
extra `0.05` on speaker similarity is because ECAPA cosine variance
on small held-out sets is ~±0.1; gating on a strict positive delta
would be too noisy.

**Citation.** `packages/training/scripts/kokoro/eval_kokoro.py:73`
(`_build_comparison`).

---

## When to update this doc

Update this page when any of these change:

- A gate threshold (the YAML configs under
  `packages/training/scripts/kokoro/configs/` or the F1/latency
  constants in the turn-detector scripts).
- The model used to compute a metric (e.g. swapping ECAPA for a
  WeSpeaker eval encoder, or switching to a different UTMOS
  checkpoint).
- The required sample rate of any consumer in the table above.
- The sign convention of a comparison delta.

The unit tests in
`packages/training/scripts/kokoro/__tests__/test_metric_units.py`
pin the helper math; this doc pins the contract those helpers
implement. Both should move together.
