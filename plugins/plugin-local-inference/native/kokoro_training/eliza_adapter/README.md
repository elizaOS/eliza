# milady_adapter

Thin bridge between Eliza's training scripts (under
`packages/training/scripts/kokoro/`) and the vendored `kokoro_training`
trainer in the parent directory.

## Why this exists

The vendor (`jonirajala/kokoro_training`) ships a self-contained
training loop for a Kokoro-inspired encoder-decoder TTS transformer.
We need it because the official `hexgrad/Kokoro-82M` PyPI package does
NOT expose a training entrypoint — the `extract_voice_embedding.py`
mel-fit path is the only learning we can do against the released
weights, and that is voice-clone, not fine-tune.

The vendor's training code, however, uses conventions that don't match
ours:

- AdamW instead of APOLLO (we require APOLLO).
- Step-driven config (`max_steps`) vs. epoch-driven (`num_epochs`).
- Vendor's own config schema vs. our YAML schema.
- Vendor expects to own the optimizer + scheduler vs. our adapter
  pattern.

`milady_adapter` translates between the two and is the only Eliza-side
code that depends on the vendor's internal structure. Re-vendoring the
upstream means only `milady_adapter/` may need adjustment.

## Surface (stable)

```python
from milady_adapter import (
    VendorEnvironment,
    probe_vendor_environment,
    build_vendor_config,
    run_full_finetune,
    smoke_full_finetune,
)
```

- `probe_vendor_environment()` — returns a `VendorEnvironment` with
  `{available, missing, has_cuda, has_mps, vendor_root}`. Used by
  `finetune_kokoro.py` to decide whether to run smoke vs. real path.
- `build_vendor_config(cfg, *, corpus_dir, output_dir, dataset_size_hint)`
  — translates the elizaOS YAML cfg dict into a `VendorConfigPlan`.
- `run_full_finetune(cfg, *, corpus_dir, output_dir, dataset_size_hint)`
  — drives the vendor's `EnglishTrainer.train()` end-to-end with
  APOLLO swapped in.
- `smoke_full_finetune(*, corpus_dir, output_dir, steps=2)` — pure
  smoke: import surface + one forward+backward pass on a tiny
  synthetic batch.

## How `finetune_kokoro.py` uses it

The Eliza-side `finetune_kokoro.py` has two modes:

- `--mode=lora-experimental` — legacy LoRA path that depends on the
  installed `kokoro` PyPI package's `KModel.forward_train` (which
  doesn't exist; see `.swarm/impl/I7-kokoro.md`). Kept for
  experimentation; gated on the missing forward.
- `--mode=full-finetune` (DEFAULT) — calls
  `milady_adapter.run_full_finetune(...)`.

When `--synthetic-smoke` is passed, the entrypoint dispatches to
`milady_adapter.smoke_full_finetune(...)` instead.

## Why we override the vendor's optimizer

`packages/training/AGENTS.md` mandates APOLLO/APOLLO-Mini for our
Kokoro fine-tunes (same as our text SFT). The vendor builds AdamW
internally in `EnglishTrainer.__init__`. We patch
`trainer.optimizer` post-construction. This is the only deviation
from "delegate everything to upstream".

If APOLLO is unavailable on the host, `run_full_finetune` raises
`SystemExit` with a clear diagnostic. We do NOT fall back to AdamW.

## Reproducibility

When `run_full_finetune` returns, the run produces:

  - `<output_dir>/checkpoints/...` (vendor's standard output).
  - `<output_dir>/train_manifest.json` (Eliza-side manifest; written
    by `finetune_kokoro.py`, NOT by the vendor).
  - `<output_dir>/vendor_smoke.json` (only in smoke mode).

The vendor's `train_manifest.json` (if it writes one) lives under
`<output_dir>/` next to the checkpoints. The Eliza-side manifest
records the vendor commit SHA (from `../VENDORED_FROM`), our config
SHA, the APOLLO version, and the dataset hash.
