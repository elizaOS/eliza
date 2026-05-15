# elizaos/eliza-1-voice-kokoro

**Eliza-1 Voice Kokoro** — Kokoro-82M base TTS weights + voice presets.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Kokoro 82M |
| Quantization | ONNX Q4 |
| Runtime | onnxruntime-node |
| License | Apache-2.0 |
| MOS expressive | 4.21 (internal eval) |
| RTF (M1 Air) | 0.42× |

## Parent Model

[hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0).

## Eval Baselines

| Metric | Score |
|--------|-------|
| MOS (expressive) | 4.21 |
| RTF (M1 Air) | 0.42× |

## Voice Presets

| Voice | Description |
|-------|-------------|
| `af_bella` | Default voice — American female, warm |
| `af_nicole` | American female, conversational |
| `af_sarah` | American female, professional |
| `af_sky` | American female, energetic |
| `am_adam` | American male, neutral |
| `am_michael` | American male, deep |
| `bf_emma` | British female, polished |
| `bf_isabella` | British female, warm |
| `bm_george` | British male, authoritative |
| `bm_lewis` | British male, casual |
| `af_samantha` | Samantha clone (best-available; see note below) |

> **Note on samantha:** The W3-11 fine-tune attempt for the samantha voice clone regressed on all quality metrics (WER +53%, SpkSim -0.21, UTMOS -34 vs baseline). The `af_samantha.bin` preset here is the best-available approximation pending corpus expansion (≥3h target). For production samantha TTS, the primary path is OmniVoice frozen-conditioning (`elizaos/eliza-1-voice-omnivoice`). See `.swarm/impl/W3-11-kokoro-post-mortem.md`.

## Files

| File | Role | Size |
|------|------|------|
| `kokoro-v1.0-q4.onnx` | Base weights (Q4) | ~311 MB |
| `voices/af_bella.bin` | Voice preset (bella) | ~512 KB |
| `voices/af_samantha.bin` | Voice preset (samantha, best-available) | ~512 KB |
| `manifest.json` | Machine-readable metadata | — |

## Coordination Note

This repo is coordinated with the F2 (kokoro samantha fine-tune) swarm agent. F2 publishes retrained weights here when quality gates pass. The current contents are the baseline release.

## License

Apache-2.0.
