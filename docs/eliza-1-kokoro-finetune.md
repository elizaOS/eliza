# Eliza-1 — Kokoro voice fine-tune

End-to-end fine-tuning pipeline for the
[`hexgrad/Kokoro-82M`](https://huggingface.co/hexgrad/Kokoro-82M) TTS model
on LJSpeech-format datasets. Lives at
[`packages/training/scripts/kokoro/`](../packages/training/scripts/kokoro/).

This doc is the **operator's guide**. For the runtime side — how a finished
voice is loaded by Eliza-1 at inference time — see
[`docs/eliza-1-kokoro-integration.md`](./eliza-1-kokoro-integration.md).

## Quickstart

You have LJSpeech-format audio (a `metadata.csv` and a `wavs/` directory of
mono WAVs). The full pipeline is one command:

```bash
bash packages/training/scripts/kokoro/run_finetune.sh \
    --data-dir   /path/to/LJSpeech-1.1 \
    --voice-name my_voice \
    --config     kokoro_lora_ljspeech.yaml \
    --output-dir /tmp/kokoro-runs/my_voice
```

Outputs land under `--output-dir`:

- `processed/` — normalized, phonemized dataset (manifest + train/val splits)
- `checkpoints/` — fine-tuned weights (`best.pt` is the best-val-loss snapshot)
- `voice.bin` — 256-dim `ref_s` style table, runtime-readable
- `kokoro.onnx` — ONNX-exported model
- `eval.json` — gate report (UTMOS / WER / speaker similarity / RTF)
- `manifest-fragment.json` — catalog fragment for the publish-time merge
- `release/<voice-name>/` — assembled, publish-ready bundle

### Voice clone (no training)

If you only have ~30 seconds of clean clips and want a **clone** rather than
a full fine-tune, skip training entirely:

```bash
uv run python3 packages/training/scripts/kokoro/extract_voice_embedding.py \
    --clips-dir /path/to/clean_clips \
    --base-model hexgrad/Kokoro-82M \
    --out /tmp/myvoice.bin
```

This runs the frozen Kokoro style encoder over each clip and averages the
resulting 256-dim `ref_s` vectors. It is by far the fastest path to a new
voice and is what most users actually want.

## Pipeline stages

| Stage | Script | What it does |
| ----- | ------ | ------------ |
| Prep | [`prep_ljspeech.py`](../packages/training/scripts/kokoro/prep_ljspeech.py) | Validate, resample to 24 kHz, loudness-normalize, phonemize via misaki[en], split 95/5 train/val, emit prep manifest. |
| Train | [`finetune_kokoro.py`](../packages/training/scripts/kokoro/finetune_kokoro.py) | LoRA or full fine-tune. APOLLO optimizer. Checkpoint every N steps + on best val loss. Resumable. Optional TensorBoard logging. |
| Extract | [`extract_voice_embedding.py`](../packages/training/scripts/kokoro/extract_voice_embedding.py) | Build the 256-dim `ref_s` table. |
| Export | [`export_to_onnx.py`](../packages/training/scripts/kokoro/export_to_onnx.py) | Trace + write `kokoro.onnx` in the [onnx-community](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) layout. Emits the manifest fragment. |
| Eval | [`eval_kokoro.py`](../packages/training/scripts/kokoro/eval_kokoro.py) | UTMOS / Whisper round-trip WER / ECAPA-TDNN speaker similarity / RTF. Gates: UTMOS ≥ 3.8, WER ≤ 8%, SpkSim ≥ 0.65, RTF ≥ 5×. |
| Package | [`package_voice_for_release.py`](../packages/training/scripts/kokoro/package_voice_for_release.py) | Stage the publish-ready bundle (`voice.bin`, `kokoro.onnx`, `voice-preset.json`, `eval.json`, `manifest-fragment.json`, `README.md`). |

## Configuration

Configs live in
[`packages/training/scripts/kokoro/configs/`](../packages/training/scripts/kokoro/configs/)
and use a one-level `extends:` chain over `base.yaml`. The shipped recipes:

- `kokoro_lora_ljspeech.yaml` — default LoRA recipe. **Recommended.**
- `kokoro_full_ljspeech.yaml` — full fine-tune. Adds the stage-2 WavLM
  adversarial loss at step 8000.
- `eliza-1-default.yaml` — Eliza-1 voice variant of the LoRA recipe with
  the right metadata block.

LoRA defaults (`base.yaml`):

- `lora_rank=16`, `lora_alpha=32`, `lora_dropout=0.05`
- Target modules: `predictor.duration_proj`, `predictor.shared`,
  `predictor.F0`, `predictor.N`, `style_encoder.linear`. Everything else
  (text encoder + iSTFTNet decoder) stays frozen.
- `learning_rate=1.0e-4`, `batch_size=8`, `grad_accum=4`, `max_steps=5000`.
- Optimizer: APOLLO-mini (same choice as Eliza-1 text SFT and the DFlash
  drafter distiller — APOLLO's projected optimizer state keeps memory
  bounded on 16 GB GPUs).

## Hardware

| Surface | Inference (ONNX, 82M) | LoRA fine-tune | Full fine-tune |
| ------- | --------------------- | -------------- | -------------- |
| Phone / mobile | yes (onnxruntime) | no | no |
| Laptop GPU, 16 GB | yes | yes | tight |
| 3090 / 4090, 24 GB | yes | yes (fast) | feasible |
| H100 / H200 | yes | trivial | standard |

LoRA on LJSpeech (13.1k clips, ~24h speech) takes roughly **2 hours on a
4090** at the shipped `max_steps=5000`. Full fine-tune is ~24h on the
same GPU. Apple-silicon MPS works for LoRA but is roughly 3× slower than
a 4090 and is not the recommended path.

The repo's APOLLO-mini optimizer integration is mandatory — there is no
non-APOLLO fallback. See
[`packages/training/AGENTS.md`](../packages/training/AGENTS.md) §2.

## Dependencies

- Base Python deps come from the `eliza-training` package (`pyyaml`,
  `numpy`, etc.).
- Kokoro-specific deps are pinned in
  [`packages/training/scripts/kokoro/requirements.txt`](../packages/training/scripts/kokoro/requirements.txt).
  Install with `pip install -r ...` or `uv pip install -r ...` in the
  same venv used by `uv run`.
- The runtime model is `kokoro>=0.9.4` (PyPI). The phonemizer is
  `misaki[en]>=0.9.4`, which **wraps espeak-ng**; install the system
  package (`brew install espeak-ng` / `apt-get install espeak-ng`) before
  the first prep run, or pass `--no-phonemize` and accept a smoke-only
  artifact.

## Synthetic smoke

Every script in the pipeline supports `--synthetic-smoke`:

```bash
bash packages/training/scripts/kokoro/jobs/smoke.sh
```

This walks prep → finetune → extract → export → eval → package with a
12-clip fabricated dataset, no GPU, no model weights. It validates the
file layout, manifest shape, and CLI plumbing in seconds. CI runs this
on every commit that touches `packages/training/scripts/kokoro/`.

## Tests

```bash
cd packages/training
uv run pytest scripts/kokoro/__tests__/ -q
```

Six tests, no network, no torch, < 1s wall clock.

## Common failures

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `ModuleNotFoundError: yaml` when running scripts directly | system python missing `pyyaml` | Run via `uv run python3 ...` or `pip install pyyaml`. |
| `synthetic-smoke needs the onnx package` | export-stage smoke ran without onnx in venv | `uv pip install onnx>=1.17.0` (the kokoro `requirements.txt` lists it). |
| `total duration <N>s < 60s minimum; not enough to fine-tune` | LJSpeech tree under the prep-time gate | The 60s floor is a hard correctness gate — fine-tuning on <60s of audio does not converge. Provide more data. |
| `apollo-torch is required` | `train` extra not installed | `uv pip install apollo-torch>=1.0.3` or `uv sync --extra train`. |
| `peft is required for LoRA fine-tunes` | base venv only | `uv pip install peft>=0.14.0`. |
| `forward_train` missing on `KModel` | upstream `kokoro` package doesn't expose it | Install the community training fork: `pip install git+https://github.com/jonirajala/kokoro_training`. |

## Publishing a custom voice

Once a run produces a green `eval.json` and a `release/<voice-name>/`
bundle, hand the voice to the Eliza-1 publish flow:

```bash
bash packages/training/scripts/publish_custom_kokoro_voice.sh \
    --release-dir /tmp/kokoro-runs/my_voice/release/my_voice \
    --bundles-root ./bundles \
    --tier 0_8b
```

The script:

1. Verifies the bundle is complete (voice.bin + kokoro.onnx +
   voice-preset.json + eval.json + manifest-fragment.json),
2. Confirms eval gates passed (or refuses, unless `--allow-gate-fail`
   with a written justification — see
   [`packages/training/AGENTS.md`](../packages/training/AGENTS.md) §6),
3. Copies the artifacts under `<bundles-root>/<tier>/tts/<voice-name>/`,
4. Emits a merge-ready note for the reviewer who appends the entry to
   `packages/app-core/src/services/local-inference/voice/kokoro/voice-presets.ts`.

The merge into `voice-presets.ts` is a **code-review step**, not a script
mutation — `package_voice_for_release.py` and `publish_custom_kokoro_voice.sh`
both refuse to edit that file. The manifest fragment is the artifact the
reviewer reads to decide what to add. This is intentional: the runtime
voice catalog is a checked-in source of truth.

## Licensing & ethics

- The base model is `hexgrad/Kokoro-82M` (Apache 2.0). Fine-tunes inherit
  the Apache 2.0 license unless your training data introduces a stronger
  obligation.
- **Voice cloning is consent-gated.** Do not run this pipeline on audio
  of a person who has not granted permission to clone their voice. The
  pipeline does not ship a consent-verification layer; that is operator
  responsibility.
- If the source data is itself licensed (e.g. LibriVox), preserve the
  attribution in your release bundle's `README.md`.

## References

- StyleTTS 2 paper: <https://arxiv.org/abs/2306.07691>
- StyleTTS 2 reference impl: <https://github.com/yl4579/StyleTTS2>
- Kokoro-82M: <https://huggingface.co/hexgrad/Kokoro-82M>
- ONNX export reference: <https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX>
- Community training fork: <https://github.com/jonirajala/kokoro_training>
- German fine-tune walkthrough: <https://github.com/semidark/kokoro-deutsch>
