# ASR fine-tune scaffold — Qwen3-ASR (eliza-1)

This directory contains the fine-tune scaffold for the **eliza-1 ASR model**
(`Qwen/Qwen3-ASR-0.6B` or `Qwen/Qwen3-ASR-1.7B`).

Per the W3-11 scope: real training is out of scope for Wave 3 (compute), but
the scaffold, eval script, manifest entry, and CI smoke tests land here.

---

## Files

| File | Purpose |
| --- | --- |
| `finetune_asr.py` | End-to-end fine-tune pipeline (real + synthetic-smoke). |
| `eval_asr.py` | WER + RTF evaluation + baseline comparison + HF-push gating. |
| `configs/base.yaml` | Base hyperparameter config for all ASR fine-tunes. |
| `configs/asr_same.yaml` | Same-corpus-specific overrides. |
| `__tests__/test_asr_pipeline.py` | CI tests (synthetic-smoke + config + gate logic). |

---

## Quick start

```bash
# CI smoke (no GPU):
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/smoke \
    --config packages/training/scripts/asr/configs/asr_same.yaml \
    --synthetic-smoke

# Real training (RTX 5080 / H200):
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/sam \
    --config packages/training/scripts/asr/configs/asr_same.yaml \
    --data-dir packages/training/data/voice/same \
    --real-train

# Eval (real checkpoint):
python3 packages/training/scripts/asr/eval_asr.py \
    --run-dir /tmp/asr-runs/sam \
    --checkpoint /tmp/asr-runs/sam/checkpoints/best.pt \
    --data-dir packages/training/data/voice/same \
    --config packages/training/scripts/asr/configs/asr_same.yaml \
    --baseline-eval artifacts/voice-fine-tune/asr-baseline/eval.json

# HF push (gated on beats-baseline + operator sign-off):
python3 packages/training/scripts/asr/finetune_asr.py \
    --run-dir /tmp/asr-runs/sam \
    --config packages/training/scripts/asr/configs/asr_same.yaml \
    --data-dir packages/training/data/voice/same \
    --real-train \
    --baseline-eval artifacts/voice-fine-tune/asr-baseline/eval.json \
    --hf-repo elizaos/eliza-1-asr-sam-v01 \
    --hf-push-if beats-baseline \
    --operator-sign-off
```

---

## Architecture

Qwen3-ASR is a **Qwen3 text backbone + audio mmproj projector**:

- **Audio front-end**: WhisperFeatureExtractor (80-bin log-mel at 16 kHz,
  n_fft=400, hop=160).
- **Projection head**: maps mel frames to Qwen3 hidden space (1024 or 2048 dim).
- **Text backbone**: Qwen3 decoder, trained to generate transcripts auto-regressively.
- **Loss**: cross-entropy on the generated token sequence (teacher-forcing).

GGUF conversion: `packages/training/scripts/quantization/gguf_asr_apply.py`
handles the two-stage convert (HF safetensors → f16 GGUF → Q4_K_M GGUF) for
both the text body and the audio mmproj sidecar.

---

## Eval gates

| Metric | Default gate | Notes |
| --- | --- | --- |
| WER | ≤ 15% | jiwer WER vs gold transcripts on val clips. |
| RTF | ≥ 2.0× | Inference must be ≥ 2× faster than realtime. |

Sam-specific config relaxes WER to ≤ 20% (5-clip val set is noisy).

Conditional HF push requires:
1. `gateResult.passed == True`
2. `comparison.beatsBaseline == True` (WER delta ≤ 0 vs baseline)
3. `--operator-sign-off` flag set explicitly.

---

## Optimizer

**APOLLO-Mini** (repo policy — APOLLO-only, no AdamW fallback). Install via:

```bash
pip install apollo-torch>=1.0.3
```

---

## Dependencies

```
torch
transformers
datasets
jiwer
librosa
soundfile
apollo-torch>=1.0.3
huggingface_hub
pyyaml
```

Install the `train` extra:

```bash
pip install -r packages/training/scripts/kokoro/requirements.txt
pip install jiwer transformers datasets
```
