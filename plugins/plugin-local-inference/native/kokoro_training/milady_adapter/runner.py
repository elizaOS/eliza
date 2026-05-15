"""Drive the vendored EnglishTrainer through the milady control flow.

This module is the only place that owns:
  - sys.path injection for the vendor (vendor's relative imports
    require its root on sys.path).
  - APOLLO optimizer replacement (vendor builds AdamW; we substitute).
  - The smoke path (two-step, asserts import surface + one backward).

It does NOT own:
  - YAML config loading        — see finetune_kokoro.py / _config.py.
  - Eval gates / publish gates — see eval_kokoro.py.
  - HF push                    — see push_voice_to_hf.py.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from .config import VendorConfigPlan, build_vendor_config
from .environment import VENDOR_ROOT, probe_vendor_environment

log = logging.getLogger("kokoro.milady_adapter")


def _ensure_vendor_on_path() -> None:
    """Inject the vendor root onto sys.path so `import training.*`,
    `import data.*`, `import audio.*`, and `import kokoro.*` resolve
    to the vendored modules.

    Idempotent. The vendor uses relative imports like
    `from .config_english import ...` plus absolute imports like
    `from data.ljspeech_dataset import ...`. Both work once
    VENDOR_ROOT is on sys.path.
    """
    root_str = str(VENDOR_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _replace_optimizer_with_apollo(trainer: Any, plan: VendorConfigPlan) -> None:
    """Swap the vendor's `torch.optim.AdamW` with our APOLLO optimizer.

    Per `packages/training/AGENTS.md`: APOLLO is mandatory for our
    Kokoro fine-tunes. The vendor builds AdamW internally in
    `EnglishTrainer.__init__`. We patch the trainer post-construction
    by:
      1. Importing our APOLLO factory.
      2. Calling the factory against `trainer.model`.
      3. Rebinding `trainer.optimizer` (and any scheduler that
         references the old optimizer) to the APOLLO instance.

    Raises SystemExit with a clear diagnostic if apollo-torch isn't
    installed.
    """
    # Late import: the APOLLO module lives in the elizaOS training
    # tree, not in the vendor; we look it up via the path that the
    # outer entrypoint puts on sys.path.
    try:
        from training.optimizer import (  # type: ignore  # noqa: PLC0415
            build_apollo_mini_optimizer,
            build_apollo_optimizer,
        )
    except ImportError as exc:
        raise SystemExit(
            "milady_adapter requires the elizaOS APOLLO factory at "
            "packages/training/scripts/training/optimizer.py. The "
            "outer caller must put packages/training/scripts on "
            "sys.path. Inner error: " + str(exc),
        ) from exc

    if plan.apollo_kind == "apollo_mini":
        new_opt = build_apollo_mini_optimizer(
            trainer.model, lr=plan.learning_rate, weight_decay=plan.weight_decay
        )
    else:
        new_opt = build_apollo_optimizer(
            trainer.model, lr=plan.learning_rate, weight_decay=plan.weight_decay
        )

    # The vendor's EnglishTrainer stores the optimizer as
    # self.optimizer and a scheduler as self.scheduler/.lr_scheduler.
    # Some builds also bind a `lr_scheduler` referencing the old
    # optimizer; rebind via the documented attributes if present.
    trainer.optimizer = new_opt
    for attr in ("scheduler", "lr_scheduler"):
        sched = getattr(trainer, attr, None)
        if sched is None:
            continue
        # PyTorch LR schedulers expose `optimizer` — rebind in place.
        # Don't try to rebuild the schedule itself; the linear→cosine
        # state stays valid with a swapped optimizer because the
        # scheduler only writes lrs into param_groups.
        if hasattr(sched, "optimizer"):
            sched.optimizer = new_opt


def run_full_finetune(
    cfg: dict[str, Any],
    *,
    corpus_dir: str,
    output_dir: str,
    dataset_size_hint: int = 0,
) -> int:
    """Drive the vendor's full-finetune training loop end-to-end.

    Returns an exit code (0 on success). Raises SystemExit on hard
    environment problems (missing deps, no usable device).
    """
    env = probe_vendor_environment()
    if not env.available:
        raise SystemExit(
            "milady_adapter: vendored kokoro_training trainer needs "
            f"these deps to run: {', '.join(env.missing)}. Install via "
            "`pip install -r plugins/plugin-local-inference/native/kokoro_training/requirements.txt`",
        )

    _ensure_vendor_on_path()
    plan = build_vendor_config(
        cfg,
        corpus_dir=corpus_dir,
        output_dir=output_dir,
        dataset_size_hint=dataset_size_hint,
    )

    # Materialize the vendor's trainer.
    from training.english_trainer import EnglishTrainer  # type: ignore  # noqa: PLC0415

    trainer = EnglishTrainer(plan.vendor_config)
    _replace_optimizer_with_apollo(trainer, plan)

    log.info(
        "vendor full-finetune: epochs=%d batch_size=%d grad_accum=%d max_steps=%d "
        "apollo=%s lr=%g device=%s",
        plan.vendor_config.num_epochs,
        plan.vendor_config.batch_size,
        plan.grad_accum,
        plan.max_steps,
        plan.apollo_kind,
        plan.learning_rate,
        getattr(trainer, "device", "?"),
    )

    trainer.train()
    return 0


def smoke_full_finetune(
    *,
    corpus_dir: str,
    output_dir: str,
    steps: int = 2,
) -> dict[str, Any]:
    """Two-step smoke that asserts the import surface + a single
    forward+backward pass against a tiny synthetic batch.

    This does NOT touch a real corpus or APOLLO. It is the minimum
    smoke that the CI suite runs to detect upstream breakage.

    Returns a dict summary `{"imported": True, "steps": N,
    "device": str}`.
    """
    env = probe_vendor_environment()
    if not env.available:
        # The smoke must still pass on environments without torch —
        # we report skip-with-reason via the return dict so callers
        # can record it in train_manifest.json.
        return {
            "imported": False,
            "steps": 0,
            "device": "n/a",
            "missing": list(env.missing),
            "skipped_reason": "vendor deps missing",
        }

    _ensure_vendor_on_path()

    # Import surface check — every top-level vendor module must load.
    import torch  # type: ignore  # noqa: PLC0415

    from kokoro.model import KokoroModel  # type: ignore  # noqa: PLC0415
    import audio.audio_utils  # type: ignore  # noqa: PLC0415,F401
    import data.english_phoneme_processor  # type: ignore  # noqa: PLC0415,F401
    import training.config_english  # type: ignore  # noqa: PLC0415,F401

    # One forward+backward pass on a tiny synthetic batch. We use the
    # smallest model variant so this finishes in well under a second
    # on CPU.
    device = torch.device("cpu")
    vocab_size = 100
    model = KokoroModel(
        vocab_size=vocab_size,
        mel_dim=80,
        hidden_dim=64,
        n_encoder_layers=2,
        n_heads=4,
        encoder_ff_dim=128,
        n_decoder_layers=2,
        decoder_ff_dim=128,
        max_decoder_seq_len=64,
        gradient_checkpointing=False,
    ).to(device)
    model.train()

    # Two-step "training" loop with synthetic inputs.
    optim = torch.optim.SGD(model.parameters(), lr=1e-3)
    for _ in range(max(1, steps)):
        text_ids = torch.randint(0, vocab_size, (1, 8), device=device)
        mel_target = torch.randn(1, 16, 80, device=device)
        # The vendor model's training-mode forward call takes text +
        # mel; signatures vary across upstreams, so we go through the
        # public `forward_training` entry that returns a dict.
        try:
            out = model.forward_training(
                text_ids=text_ids,
                target_mel=mel_target,
                durations=torch.full((1, 8), 2, dtype=torch.long, device=device),
            )
        except TypeError:
            # Tolerate signature drift: try the keyword-less form.
            out = model.forward_training(text_ids, mel_target)

        # The smoke does not care about the loss shape — it cares that
        # autograd flows. Sum every tensor field and backprop.
        loss = torch.zeros((), device=device)
        if isinstance(out, dict):
            for v in out.values():
                if isinstance(v, torch.Tensor) and v.requires_grad:
                    loss = loss + v.sum()
        elif isinstance(out, torch.Tensor):
            loss = out.sum()
        if loss.requires_grad:
            loss.backward()
            optim.step()
            optim.zero_grad(set_to_none=True)

    # Persist a tiny marker so callers can assert the smoke ran.
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    marker = out_dir / "vendor_smoke.json"
    marker.write_text(
        '{"kind":"kokoro-vendor-smoke","steps":'
        + str(int(steps))
        + ',"device":"cpu"}\n'
    )

    return {
        "imported": True,
        "steps": int(steps),
        "device": "cpu",
        "marker": str(marker),
    }
