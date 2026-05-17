# Same corpus — F2 augmented + distilled

Updated by F2 (Kokoro same fine-tune retry agent) on 2026-05-15.

## Original corpus

| Property | Value |
|----------|-------|
| Source | `lalalune/ai_voices` (upstream `sam` subset, landed locally as `same`) |
| Clips | 57 (58 raw, 1 excluded: same_002 hallucination) |
| Duration | ~3.5 min (210 s) |
| Format | 44.1 kHz mono PCM16 (normalized to 24 kHz, -23 LUFS) |
| License | Research-only — derivative of *Her* (2013, Warner Bros) |
| Commit | c6db5b5dc703e212664a17cf58114f5ecfddc853 |

## F2 augmented corpus (acoustic augmentation)

Generated at `/tmp/kokoro-f2/corpus-augmented/` by `augment_corpus.py`.

**Method:** 5 augmentation variants per non-val clip:
- `stretch_slow`: time-stretch ×0.9 (slowed)
- `stretch_fast`: time-stretch ×1.1 (sped up)
- `pitch_up`: pitch-shift +50 cents (+0.5 semitones)
- `pitch_down`: pitch-shift -50 cents (-0.5 semitones)
- `noise_15db`: Gaussian noise at 15 dB SNR

| Property | Value |
|----------|-------|
| Original clips | 57 |
| Augmented clips | 260 (52 non-val × 5 variants) |
| Total clips | 317 |
| Total duration | ~18.2 min |
| Train lines | 312 |
| Val lines | 5 (original only, no augmented val clips) |

## F2 distillation corpus (self-distillation)

Generated at `/tmp/kokoro-f2/corpus-distilled/` by `synthesize_distillation_corpus.py`.

**Method:** Kokoro-82M TTS with `af_bella` voice (same's closest available stock voice) synthesizing 80 diverse conversational English sentences covering:
- Short conversational utterances (5-10 words)
- Medium introspective statements (10-18 words)
- Longer reflective paragraphs (18-30 words)
- Questions and emotional expressions

| Property | Value |
|----------|-------|
| Clips | 406 |
| Duration | ~30 min |
| Train lines | 366 |
| Val lines | 40 |
| Voice used | af_bella (Kokoro stock) |
| Purpose | Teacher-student distillation: expand training signal |

## F2 merged corpus

Merged at `/tmp/kokoro-f2/corpus-merged/` by `merge_corpus.py`.

| Property | Value |
|----------|-------|
| Train lines | 678 |
| Val lines | 45 |
| Estimated total duration | ~48 min |
| Sources | augmented (real same) + distilled (af_bella synthesis) |

## Training experiments

| Experiment | Config | Status | UTMOS | WER | SpkSim | beatsBaseline |
|------------|--------|--------|-------|-----|--------|---------------|
| mel-fit 0 | anchor=0.0 lr=0.005 steps=1200 init=bella | Done | 2.006 | 0.992 | 0.145 | false |
| mel-fit 1 | anchor=0.05 lr=0.005 steps=1200 init=bella | Done | 2.004 | 1.000 | 0.147 | false |
| mel-fit 2 | anchor=0.1 lr=0.005 steps=1600 init=bella | Done | 2.003 | 1.048 | 0.119 | false |
| mel-fit 3 | anchor=0.0 lr=0.01 steps=800 init=nicole | Done | 2.004 | 1.000 | 0.122 | false |
| mel-fit 5 | anchor=0.0 lr=0.002 steps=2000 init=bella | Done | 2.004 | 0.678 | 0.159 | false |
| full-FT | lr=3e-5 5k steps augmented corpus | Running | — | — | — | — |

## Baseline (af_bella on same val prompts)

| Metric | Value |
|--------|-------|
| UTMOS | 4.371 |
| WER | 0.000 |
| SpkSim | 0.034 |
| RTF | 91.4× |

Note: af_bella SpkSim of 0.034 reflects that af_bella and same are different speakers.
Any fine-tune that moves SpkSim > 0.034 + 0.05 = 0.084 AND improves UTMOS + WER beats baseline.

## Key finding (F2)

The mel-fit objective consistently achieves SpkSim 0.11-0.16 (vs baseline 0.034) — the voice IS moving toward same. However UTMOS collapses to 2.0 and WER to ~1.0. This confirms the Q1 re-eval diagnosis: mel-fit moves the speaker centroid but destroys audio quality because ref_s timbre and prosody halves were jointly learned by the StyleTTS-2 trainer; gradient descent on ref_s alone in an inference-only package cannot maintain their joint coherence.

The full-FT on the augmented+distilled corpus is the structural fix — it trains all model weights jointly against the mel-reconstruction objective on a much larger corpus.

## Scripts

| Script | Purpose |
|--------|---------|
| `augment_corpus.py` | Acoustic augmentation (F2) |
| `synthesize_distillation_corpus.py` | Self-distillation synthesis (F2) |
| `merge_corpus.py` | Merge multiple corpus dirs |
| `prep_merged_corpus.py` | Prep processed/ dir for finetune_kokoro_full.py |
| `run_f2_pipeline.py` | Full F2 orchestrator |
