# #10726 — STT-quality, noise-rejection & speaker-isolation real benches (Linux x86-64, CPU)

Real-weight runs on 2026-07-02 (host fused `libelizainference.so`, published eliza-1-asr GGUF, republished Kokoro `kokoro-82m-v1_0.gguf` F16, published pyannote + WeSpeaker GGUFs). No mocks; every lane fails closed under its `*_REQUIRE=1` flag. Corpus is synthesized from fixed transcripts via real Kokoro TTS, so absolute WER carries a small TTS-pronunciation floor — cross-condition deltas are the signal.

Lanes (in `plugins/plugin-local-inference`):
- `sttquant:real` → `scripts/stt-quant-bench-real.ts`
- `noise:real` → `scripts/noise-rejection-real.ts`
- `speakeriso:real` → `scripts/speaker-isolation-real.ts`

## 1. STT quant — `stt-quant-bench.md` — **PASS**

| variant | size (MB) | load (ms) | mean WER | median WER | mean ms/utt | RTF | × realtime |
|---|---:|---:|---:|---:|---:|---:|---:|
| bundle-2b (shipped) | 1019 | 1851 | 0.008 | 0.000 | 1213 | 0.262 | 3.8× |

Real ASR over 12 Kokoro utterances (55.5 s). Only the shipped 2b quant is downloadable from `elizaos/eliza-1` today, so it's the only row — additional quants will populate the table when published (the harness accepts any set of quant GGUFs). Selection recommendation: **bundle-2b** is accurate (WER 0.008) and comfortably real-time (3.8×) on CPU; no faster-but-lossier quant is needed on this tier until a lower-RAM device forces it.

## 2. Noise rejection — `noise-rejection.md` — **PASS** (WER vs SNR)

clean mean WER **0.008**.

| noise \ SNR (dB) | 20 | 10 | 5 | 0 | -5 |
|---|---:|---:|---:|---:|---:|
| white | 0.008 | 0.038 | 0.040 | 0.094 | 0.310 |
| pink (traffic surrogate) | 0.008 | 0.030 | 0.040 | 0.117 | 0.355 |
| music | 0.008 | 0.008 | 0.008 | 0.008 | 0.016 |
| babble | 0.029 | 0.039 | 0.119 | 0.585 | 0.926 |

Gate: clean ≤ 0.35, WER at SNR ≥ 10 dB ≤ 0.55, curves quasi-monotone (tol 0.15) — **PASS**. Physically sensible: music barely perturbs ASR, babble (competing speech) is the hardest and only collapses below 0 dB.

## 3. Speaker isolation — `speaker-isolation.md` — **encoder PASS, diarizer regression FOUND**

Two real Kokoro voices, 8-turn / 40 s gap-separated dialogue.

- **Speaker attribution via the WeSpeaker encoder: 6/6 correct, accuracy 1.000** (intra-speaker dist 0.178 vs inter 0.958, margin 0.780) — **PASS**. Embedding-based isolation is solid.
- **Diarizer DER 1.000** — the pyannote segmenter over-detects (emits ~56 s of dropped-too-short micro-segments on 34.6 s of real speech; `localSpeakerCount=3`, `hasOverlap=true` on a clean non-overlapping 2-speaker signal). This is a real regression, filed as **#11377** (same over-detect class as #9460; likely a stale pre-fix GGUF, cf. the Kokoro drift in #9588). The lane hard-fails on it by design — that failure is the intended de-larp signal, not a broken test.

## How to reproduce

```bash
export ELIZA_INFERENCE_LIBRARY=<host libelizainference.so>
export ELIZA_ASR_BUNDLE=<asr-bundle dir>
export ELIZA_KOKORO_MODEL_DIR=<dir with kokoro-82m-v1_0.gguf + voices/*.bin>
export ELIZA_DIARIZ_GGUF=<pyannote-segmentation-3.0.gguf>
export ELIZA_SPEAKER_GGUF=<wespeaker-resnet34-lm.gguf>
bun run --cwd plugins/plugin-local-inference sttquant:real   # PASS
bun run --cwd plugins/plugin-local-inference noise:real      # PASS
bun run --cwd plugins/plugin-local-inference speakeriso:real # encoder PASS, diarizer DER fails → #11377
```

Missing any weight → the lane SKIPs with a reason, or hard-fails under `SPEAKER_ISO_REQUIRE=1` / `STT_QUANT_REQUIRE=1` / `NOISE_REJECT_REQUIRE=1`.
