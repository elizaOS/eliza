"""Optional Transformer Engine FP8 training pass for the H200 (sm_90) tier.

Hardware support
----------------
- H100 / H200 SXM (sm_90): full FP8 path; ~25-30% step-time win vs bf16
  (Meta, Microsoft, karpathy/nanochat #382 published numbers).
- B200 (sm_100): FP8 + MXFP8/NVFP4. Not in our fleet yet.
- RTX 6000 Blackwell, RTX 5090 (sm_120 consumer Blackwell): TE loads but
  FP8 recipes silently fall back to bf16. vLLM #31085, FlashInfer #2577 and
  TE family-check confirm sm_120 is not on the FP8 enable path. We gate on
  the cuda capability so this module is a no-op there.
- A100 (sm_80) and earlier: no FP8 tensor cores; we skip silently.

What this swaps
---------------
Replaces ``nn.Linear`` modules in the attention QKV / output and MLP up/gate/down
projections with ``transformer_engine.pytorch.Linear``, then wraps the model
forward in ``te.fp8_autocast`` so the matmul runs in E4M3 / E5M2 with delayed
scaling. Master weights stay bf16 (per ``estimate_train``'s 3-byte-per-param
accounting in ``memory_calc.py``); gradients stay bf16 too.

Liger kernels (RMSNorm / SwiGLU / RoPE / FLCE) are NOT touched — they fuse
ops TE doesn't replace, so the two stack cleanly.

FSDP compatibility
------------------
TE Linear is FSDP-1 and FSDP-2 compatible per nanochat #382. We don't change
any FSDP wrap policy here; just patch leaf Linear modules.

Usage
-----
::

    from training.te_fp8 import maybe_enable_fp8
    handle = maybe_enable_fp8(model)            # no-op off-target
    if handle.enabled:
        with handle.autocast():                  # wrap the train step
            loss = model(**batch).loss

The caller can also set the env var ``ELIZA_FP8_TRAIN=1`` to opt in
explicitly when ``maybe_enable_fp8`` would otherwise no-op (e.g., to test
the patch on an A100).
"""

from __future__ import annotations

import contextlib
import logging
import os
from dataclasses import dataclass
from typing import Iterator

import torch
from torch import nn

log = logging.getLogger(__name__)


@dataclass
class FP8Handle:
    enabled: bool
    """True when TE replaced at least one Linear and the autocast is live."""
    n_replaced: int = 0
    """Linear modules swapped to TE."""
    reason_skipped: str = ""

    @contextlib.contextmanager
    def autocast(self) -> Iterator[None]:
        if not self.enabled:
            yield
            return
        import transformer_engine.pytorch as te
        recipe = _build_recipe()
        with te.fp8_autocast(enabled=True, fp8_recipe=recipe):
            yield


def _build_recipe():
    """E4M3 weights + E5M2 grads with delayed-scaling history of 16 steps —
    the standard FP8 recipe used by Llama-3 and nanochat. Override via env
    ``ELIZA_FP8_RECIPE={delayed,current}``.
    """
    from transformer_engine.common import recipe as _r

    flavor = os.environ.get("ELIZA_FP8_RECIPE", "delayed")
    if flavor == "current":
        return _r.DelayedScaling(
            margin=0, fp8_format=_r.Format.HYBRID,
            amax_history_len=1, amax_compute_algo="most_recent",
        )
    return _r.DelayedScaling(
        margin=0, fp8_format=_r.Format.HYBRID,
        amax_history_len=16, amax_compute_algo="max",
    )


_TE_TARGET_NAME_HINTS: tuple[str, ...] = (
    "q_proj", "k_proj", "v_proj", "o_proj",      # attention
    "gate_proj", "up_proj", "down_proj",         # MLP / experts
)


def _swap_linear_to_te(model: nn.Module) -> int:
    import transformer_engine.pytorch as te

    swapped = 0
    for parent_name, parent in model.named_modules():
        for child_name, child in list(parent.named_children()):
            if not isinstance(child, nn.Linear):
                continue
            if not any(h in child_name for h in _TE_TARGET_NAME_HINTS):
                continue
            te_lin = te.Linear(
                in_features=child.in_features,
                out_features=child.out_features,
                bias=child.bias is not None,
                params_dtype=child.weight.dtype,
            )
            with torch.no_grad():
                te_lin.weight.copy_(child.weight)
                if child.bias is not None:
                    te_lin.bias.copy_(child.bias)
            te_lin = te_lin.to(child.weight.device)
            setattr(parent, child_name, te_lin)
            swapped += 1
    return swapped


def maybe_enable_fp8(model: nn.Module) -> FP8Handle:
    """Patch model in-place if the silicon supports FP8 training.

    Skips silently and returns a disabled handle if:
      * No CUDA available.
      * GPU compute capability isn't (9, 0) — H100/H200 — and
        ``ELIZA_FP8_TRAIN`` is not set explicitly.
      * ``transformer_engine`` isn't importable.
    """
    if not torch.cuda.is_available():
        return FP8Handle(enabled=False, reason_skipped="no cuda")

    cap = torch.cuda.get_device_capability(0)
    forced = os.environ.get("ELIZA_FP8_TRAIN") in ("1", "true", "yes")
    if cap != (9, 0) and not forced:
        return FP8Handle(
            enabled=False,
            reason_skipped=(
                f"compute_capability={cap} — TE FP8 is gated to sm_90 (H100/"
                "H200). Set ELIZA_FP8_TRAIN=1 to force the swap on other "
                "silicon (will silently fall back to bf16 on sm_120/sm_80)."
            ),
        )

    try:
        import transformer_engine.pytorch as te  # noqa: F401
    except ImportError:
        return FP8Handle(
            enabled=False,
            reason_skipped=(
                "transformer_engine not installed — `uv pip install "
                "transformer_engine[pytorch]` to enable TE FP8 training."
            ),
        )

    n = _swap_linear_to_te(model)
    if n == 0:
        return FP8Handle(
            enabled=False, n_replaced=0,
            reason_skipped=(
                "no nn.Linear modules matched TE swap hints "
                f"({_TE_TARGET_NAME_HINTS}); model layout unfamiliar?"
            ),
        )
    log.info("TE FP8: swapped %d Linear modules; cap=%s, recipe=%s",
             n, cap, os.environ.get("ELIZA_FP8_RECIPE", "delayed"))
    return FP8Handle(enabled=True, n_replaced=n)


__all__ = ["FP8Handle", "maybe_enable_fp8"]
