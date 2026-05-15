"""Translate the elizaOS finetune_kokoro config schema into the vendored
trainer's `EnglishTrainingConfig` dataclass.

The Eliza side speaks YAML (see
`packages/training/scripts/kokoro/configs/base.yaml`) keyed by:
  - mode, optimizer, learning_rate, weight_decay, betas, warmup_steps,
    scheduler, grad_clip, batch_size, grad_accum, max_steps,
    eval_every, checkpoint_every, log_every, bf16, mel_loss_weight,
    duration_loss_weight, ...

The vendor side speaks a dataclass with overlapping but not identical
fields (no APOLLO; LinearLR + CosineAnnealingLR scheduler; per-stage
mel coarse/refined weights instead of single mel; epoch-driven, not
step-driven).

This module maps the overlap explicitly and records the gap. Anything
the vendor needs but our YAML doesn't provide uses a deterministic
fallback documented inline.

Importantly: the vendor's optimizer factory is NOT APOLLO. Per
`packages/training/AGENTS.md` we MUST run training under APOLLO. The
adapter does this by:
  1. Letting the vendor build the model + dataset.
  2. Replacing the vendor's `torch.optim.AdamW` instance with our
     APOLLO optimizer (built via
     `packages/training/scripts/training/optimizer.py`).
  3. Re-binding the scheduler against the APOLLO optimizer.

That is the only deviation from "delegate to upstream verbatim".
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass
class VendorConfigPlan:
    """Materialized vendor config plus the elizaOS-side knobs the adapter
    consumes directly (APOLLO, grad_accum, step-count caps).

    `vendor_config` is an instance of
    `kokoro_training.training.config_english.EnglishTrainingConfig`
    (loaded lazily so this module doesn't drag torch into smoke).
    """

    vendor_config: Any
    apollo_kind: str  # "apollo" or "apollo_mini"
    learning_rate: float
    weight_decay: float
    grad_clip: float
    grad_accum: int
    max_steps: int
    log_every: int
    eval_every: int
    checkpoint_every: int
    mel_loss_weight: float
    duration_loss_weight: float
    bf16: bool


def _select_model_size(cfg: dict[str, Any]) -> str:
    """Pick a vendor model size from the elizaOS cfg.

    The vendor exposes `small | medium | default | large`. We expose
    `model_size` directly in the YAML for full-finetune configs; default
    to `medium` (25M, recommended for LJSpeech-class corpora — the
    samantha corpus at ~50 clips is much smaller, so a 6M / `small`
    model is the safer pick. The cfg explicitly opting in to `medium`
    or higher overrides).
    """
    raw = cfg.get("model_size", None)
    if raw is None:
        # Heuristic: small corpora get small models.
        max_steps = int(cfg.get("max_steps", 5000))
        if max_steps <= 2500:
            return "small"
        return "medium"
    if raw not in ("small", "medium", "default", "large"):
        raise ValueError(f"unknown model_size: {raw!r}")
    return str(raw)


def _epochs_from_steps(
    max_steps: int, dataset_size_hint: int, batch_size: int, grad_accum: int
) -> int:
    """The vendor is epoch-driven (`num_epochs`). The elizaOS YAML is
    step-driven (`max_steps`). Convert by assuming a uniform batches-
    per-epoch shape with our effective batch size, with a minimum of
    1 epoch.
    """
    if dataset_size_hint <= 0 or batch_size <= 0:
        return max(1, max_steps // 500)
    effective_batch = max(1, batch_size * grad_accum)
    steps_per_epoch = max(1, math.ceil(dataset_size_hint / effective_batch))
    return max(1, math.ceil(max_steps / steps_per_epoch))


def build_vendor_config(
    cfg: dict[str, Any],
    *,
    corpus_dir: str,
    output_dir: str,
    dataset_size_hint: int = 0,
) -> VendorConfigPlan:
    """Build a `VendorConfigPlan` from the elizaOS cfg.

    Raises:
      SystemExit if the vendored config module isn't importable.
      ValueError if the cfg picks unknown options (model_size,
        optimizer that the vendor doesn't carry).

    The plan returned is *fully constructed* — callers can pass it
    straight into `run_full_finetune`. The torch import is deferred
    to the runner; this function performs only a single import of the
    vendor's `config_english` module.
    """
    # The vendor lives at <vendor_root>/training/config_english.py.
    # Importing it requires <vendor_root> to be on sys.path; we let the
    # caller arrange that (see runner._ensure_vendor_on_path).
    from training.config_english import EnglishTrainingConfig  # type: ignore  # noqa: PLC0415

    optimizer = str(cfg.get("optimizer", "apollo_mini"))
    if optimizer not in ("apollo", "apollo_mini"):
        # Vendor's default factory uses AdamW; we always override to
        # APOLLO. Reject anything else upstream so the contract is
        # explicit at config-build time.
        raise ValueError(
            f"unsupported optimizer for full-finetune: {optimizer!r}; "
            "must be one of: apollo, apollo_mini",
        )

    batch_size = int(cfg.get("batch_size", 8))
    grad_accum = int(cfg.get("grad_accum", 4))
    max_steps = int(cfg.get("max_steps", 5000))
    num_epochs = _epochs_from_steps(max_steps, dataset_size_hint, batch_size, grad_accum)

    vendor_cfg = EnglishTrainingConfig(
        data_dir=corpus_dir,
        output_dir=output_dir,
        num_epochs=num_epochs,
        batch_size=batch_size,
        learning_rate=float(cfg.get("learning_rate", 1e-4)),
        validation_split=float(cfg.get("val_fraction", 0.05)),
        warmup_epochs=max(1, int(cfg.get("warmup_steps", 200)) // 200),
        weight_decay=float(cfg.get("weight_decay", 0.0)),
        mel_coarse_loss_weight=float(cfg.get("mel_loss_weight", 1.0)) * 0.5,
        mel_refined_loss_weight=float(cfg.get("mel_loss_weight", 1.0)),
        duration_loss_weight=float(cfg.get("duration_loss_weight", 0.01)),
        stop_token_loss_weight=0.1,
        use_mixed_precision=bool(cfg.get("bf16", True)),
        sample_rate=int(cfg.get("sample_rate", 22050)),
        n_mels=80,
    )

    return VendorConfigPlan(
        vendor_config=vendor_cfg,
        apollo_kind=optimizer,
        learning_rate=float(cfg.get("learning_rate", 1e-4)),
        weight_decay=float(cfg.get("weight_decay", 0.0)),
        grad_clip=float(cfg.get("grad_clip", 1.0)),
        grad_accum=grad_accum,
        max_steps=max_steps,
        log_every=int(cfg.get("log_every", 25)),
        eval_every=int(cfg.get("eval_every", 500)),
        checkpoint_every=int(cfg.get("checkpoint_every", 500)),
        mel_loss_weight=float(cfg.get("mel_loss_weight", 1.0)),
        duration_loss_weight=float(cfg.get("duration_loss_weight", 0.01)),
        bf16=bool(cfg.get("bf16", True)),
    )
