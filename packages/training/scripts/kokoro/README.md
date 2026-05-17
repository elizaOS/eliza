# Kokoro-82M fine-tune pipeline

End-to-end fine-tuning pipeline for the
[`hexgrad/Kokoro-82M`](https://huggingface.co/hexgrad/Kokoro-82M) TTS model
(StyleTTS-2 + iSTFTNet) on LJSpeech-format datasets. Produces:

1. A fine-tuned PyTorch checkpoint.
2. A **voice-style embedding `.bin`** that the runtime's Kokoro inference
   backend (`packages/app-core/src/services/local-inference/voice/kokoro/`)
   can load directly.
3. An **ONNX export** matching the layout used by
   [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
   so a fine-tune can ship through the existing runtime path without code
   changes.
4. A **publish manifest fragment** ready for review and inclusion in the
   Eliza-1 catalog publish flow.

## Architecture and recipe — what we settled on

Kokoro-82M is a **decoder-only StyleTTS-2** descendant. There is **no
first-party fine-tune recipe**. The community-validated approach (see the
`kokoro-deutsch` workflow and `jonirajala/kokoro_training`) is a two-stage
StyleTTS-2 training with the WavLM discriminator activated only in stage 2.

We support two modes:

- **`--mode lora`** (default, recommended). Attach LoRA adapters to:
  - the **prosody predictor** (duration + F0/N modules) and
  - the **style encoder** projection,
  while keeping the text encoder and the iSTFTNet decoder weights frozen.
  This is the lightest path that still meaningfully changes a voice — it
  re-targets prosody and timbre conditioning, which is what users actually
  want when they say "fine-tune a voice." Trains on a 16 GB consumer GPU.

- **`--mode full`**. Full fine-tune. Unfreezes all modules. Resource-intensive
  (40+ GB at batch size 8, ~24h on a 4090 for 13k LJSpeech clips). Use only
  when LoRA quality is insufficient.

A pure **single-speaker voice clone** does NOT require touching the model
weights at all — `extract_voice_embedding.py` can take ~30 seconds of clean
audio, run it through the (frozen) style encoder, and average the resulting
ref_s vectors. That is what most users want and is the **fastest path**.
Fine-tuning is for cases where the target voice has prosody / phonology
genuinely outside the base distribution.

## Voice-style embedding format

Kokoro voices are **256-dim float32** `ref_s` vectors. The community
`voices/*.bin` files store **one ref_s per phoneme-length bucket** (Kokoro
gates its style table on the synthesized utterance length, so the runtime
indexes into the bin by `min(len(phonemes), N-1)`). Shape on disk:
`(N, 1, 256)` Float32 LE, `N=510` in the canonical voice packs.

`extract_voice_embedding.py` produces the same shape, and the resulting
file is consumable both by:

- the upstream Kokoro inference path (`np.fromfile(..., dtype=np.float32).reshape(-1, 1, 256)`),
- the Milady runtime's voice preset format (see
  `packages/app-core/src/services/local-inference/voice/voice-preset-format.ts`),
  via a thin wrapper that wraps the 256-dim vector inside the ELZ1
  preset envelope. `package_voice_for_release.py` is the wrapper.

## Hardware bifurcation

| Tier             | Inference (ONNX, 82M) | LoRA fine-tune | Full fine-tune |
| ---------------- | --------------------- | -------------- | -------------- |
| Phone / mobile   | yes (ONNX runtime)    | no             | no             |
| Laptop GPU 16 GB | yes                   | yes            | tight          |
| 3090 / 4090 24 GB| yes                   | yes (fast)     | feasible       |
| H100 / H200      | yes                   | trivial        | standard       |

CPU-only is supported by **all** scripts in `--dry-run` mode for CI
import-checks; actual training requires CUDA or MPS.

## Pipeline

```text
LJSpeech dataset                                voice embedding (.bin)
        │                                              ▲
        ▼                                              │
  prep_ljspeech.py ───► <dataset>/processed/           │
        │                  ├── train_list.txt          │
        │                  ├── val_list.txt            │
        │                  ├── wavs_norm/              │
        │                  └── phonemes.jsonl          │
        ▼                                              │
  finetune_kokoro.py ─► checkpoints/  ──► extract_voice_embedding.py
        │                                              │
        ▼                                              ▼
   eval_kokoro.py        export_to_onnx.py ──► .onnx + .bin
        │                                              │
        ▼                                              ▼
                  package_voice_for_release.py
                              │
                              ▼
                   manifest-fragment.json (staged for review)
```

## Inputs

LJSpeech-format directory:

```
<dataset>/
├── metadata.csv     # "id|raw_text|normalized_text" per line
└── wavs/
    ├── LJ001-0001.wav
    └── ...          # mono 22050 Hz WAV
```

## Outputs

- `<run-dir>/processed/` — normalized audio + phonemized manifest
- `<run-dir>/checkpoints/` — fine-tuned PyTorch weights (+ LoRA deltas)
- `<run-dir>/voice.bin` — 256-dim ref_s voice-style table
- `<run-dir>/kokoro.onnx` — ONNX-exported fine-tune
- `<run-dir>/eval.json` — UTMOS / WER / speaker-similarity / RTF
- `<run-dir>/manifest-fragment.json` — staged catalog entry

## Quickstart

```bash
# Pure voice clone — no training, ~30s of clean audio in
python3 scripts/kokoro/extract_voice_embedding.py \
    --clips-dir /path/to/clean_clips \
    --base-model hexgrad/Kokoro-82M \
    --out /tmp/myvoice.bin

# Full LoRA fine-tune on LJSpeech-format data
bash scripts/kokoro/jobs/finetune_default_voice.sh /path/to/LJSpeech-1.1
```

## Hyperparameter rationale

LoRA defaults (`configs/kokoro_lora_ljspeech.yaml`):

| Parameter         | Value     | Why                                                                  |
| ----------------- | --------- | -------------------------------------------------------------------- |
| `lora_rank`       | 16        | Standard StyleTTS-2 community choice; r=8 underfits prosody, r=32 overfits on <30h. |
| `lora_alpha`      | 32        | `2 * rank`, gives effective LR ~lr.                                  |
| `learning_rate`   | 1e-4      | LoRA-only is robust at this LR; full fine-tune drops to 5e-5.       |
| `batch_size`      | 8         | Fits on 16 GB at seq_len 30s.                                        |
| `grad_accum`      | 4         | Effective batch 32, matches `jonirajala/kokoro_training` finding.    |
| `max_steps`       | 5000      | LJSpeech (13.1k clips) ≈ 8 epochs at bs=32.                          |
| `eval_every`      | 500       | UTMOS + WER on a 50-clip held-out split.                              |
| `target_modules`  | predictor.duration_proj, predictor.shared, predictor.F0, predictor.N, style_encoder.linear | Only the prosody + style projections; text encoder + decoder frozen. |
| `mel_loss_weight` | 1.0       | Primary objective.                                                   |
| `duration_loss_weight` | 0.01 | Tiny — duration loss otherwise dominates and washes out mel gradient.|

Full fine-tune (`configs/kokoro_full_ljspeech.yaml`) drops `lora_*`, sets
`learning_rate=5e-5`, `max_steps=20000`, and adds a `wavlm_adversarial`
stage-2 phase that activates at step 8000.

## Evaluation gates

The pipeline computes four numbers per checkpoint:

1. **UTMOS** (predicted MOS) — should be ≥ 3.8 to ship.
2. **WER** vs reference transcripts via Whisper large-v3 — should be ≤ 8%.
3. **Speaker-similarity** (ECAPA-TDNN cosine) vs reference clip — ≥ 0.65.
4. **RTF** on the recording machine — ≥ 5× faster-than-real-time on a 4090.

`eval_kokoro.py` emits `eval.json` with all four. The publish step refuses
to stage a manifest fragment if any gate fails (override with
`--allow-gate-fail` and a written justification, mirroring the Eliza-1
publish protocol).

## Dependencies

The scripts use the existing `packages/training/pyproject.toml`'s `train`
extra (torch, transformers, accelerate, peft, datasets) plus a small Kokoro-
specific surface that is documented inline in each script:

- `kokoro>=0.9.4` (PyPI) — runtime, used by extract / eval / export.
- `misaki[en]>=0.9.4` — phonemizer.
- `onnx>=1.17.0` and `onnxruntime>=1.20.0` — export + smoke.
- `librosa>=0.10.0`, `pyloudnorm>=0.1.1`, `soundfile>=0.12.0` — audio prep.
- `openai-whisper>=20240930` — WER eval.
- `speechbrain>=1.0.0` — ECAPA-TDNN speaker similarity.
- `utmos>=0.1.0` — predicted-MOS scoring (falls back to torchaudio's
  speech enhancement metric if `utmos` is not installed).

All optional at import time — every script has a `--dry-run` flag that
exercises argparse, config load, and pipeline shape without importing
torch or downloading weights.

## Tests

```bash
cd packages/training
uv run pytest scripts/kokoro/__tests__ -q
```

The test suite builds a tiny synthetic LJSpeech fixture in a temp dir
(3 clips of 1s silence with metadata) and exercises `prep_ljspeech.py`
end-to-end. No network, no torch, runs on CPU in < 5s.

## References

- StyleTTS 2 paper: https://arxiv.org/abs/2306.07691
- StyleTTS 2 reference impl: https://github.com/yl4579/StyleTTS2
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- ONNX export: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- Community training repos:
  - https://github.com/jonirajala/kokoro_training
  - https://github.com/semidark/kokoro-deutsch
  - https://github.com/lucasjinreal/Kokoros
- Voice embedding format reference: https://github.com/nazdridoy/kokoro-tts (voice blending)

Sources:
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- [jonirajala/kokoro_training](https://github.com/jonirajala/kokoro_training)
- [semidark/kokoro-deutsch](https://github.com/semidark/kokoro-deutsch/discussions/8)
- [Kokoro-82M ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
