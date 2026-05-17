"""APOLLO optimizer factories for full-parameter SFT.

APOLLO ("Approximated Gradient Scaling for Memory-Efficient LLM Optimization",
Zhu et al., MLSys 2025, arXiv:2412.05270) gives low optimizer-state memory
while retaining adaptive optimizer behavior. It is the only optimizer exposed
by the local eliza-1 training entrypoints.

Important: keep Eliza-1 fine-tuning on APOLLO/APOLLO-Mini. The projected
optimizer state is what lets full-parameter Qwen-based tuning run on smaller
GPUs where ordinary full-size moment buffers do not fit.

The two factories below produce parameter groups matching the recipe used in
the reference implementation (https://github.com/zhuhanqing/APOLLO,
`apollo-torch` PyPI):

    APOLLO       — channel-wise scaling, rank=256, scale=1
    APOLLO-Mini  — tensor-wise scaling,  rank=1,   scale=128

Only 2-D weight matrices (q/k/v/o, gate/up/down) are routed through the
low-rank projector; biases, embeddings, lm_head, and norms stay in APOLLO's
unprojected parameter group.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch
from torch import nn


# Module-name fragments whose parameters always stay in the unprojected group.
# Embeddings + lm_head dominate the parameter count of small LLMs but the
# projector cannot shape them; biases and norms are tiny and 1-D.
_NON_LOWRANK_NAME_HINTS: tuple[str, ...] = (
    "embed",
    "lm_head",
    "norm",
    "layernorm",
)


@dataclass(frozen=True)
class _ApolloRecipe:
    rank: int
    scale: float
    scale_type: str          # "channel" or "tensor"
    update_proj_gap: int
    proj: str                # "random" (APOLLO) or "svd" (GaLore-style)
    proj_type: str           # "std", "right", "left", "full"
    scale_front: bool
    disable_nl: bool


_APOLLO_DEFAULT = _ApolloRecipe(
    rank=256,
    scale=1.0,
    scale_type="channel",
    update_proj_gap=200,
    proj="random",
    proj_type="std",
    scale_front=False,
    disable_nl=False,
)


# APOLLO-Mini per the paper §4.2. `scale_front=True` per the upstream README's
# rank-1 recommendation.
_APOLLO_MINI = _ApolloRecipe(
    rank=1,
    scale=128.0,
    scale_type="tensor",
    update_proj_gap=200,
    proj="random",
    proj_type="std",
    scale_front=True,
    disable_nl=False,
)


def _split_params(
    model: nn.Module,
) -> tuple[list[nn.Parameter], list[nn.Parameter]]:
    """Partition trainable params into (lowrank_2d_weights, everything_else)."""

    lowrank: list[nn.Parameter] = []
    other: list[nn.Parameter] = []
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        lname = name.lower()
        if any(h in lname for h in _NON_LOWRANK_NAME_HINTS) or p.dim() != 2:
            other.append(p)
        else:
            lowrank.append(p)
    return lowrank, other


def _build_param_groups(
    model: nn.Module,
    *,
    weight_decay: float,
    recipe: _ApolloRecipe,
) -> list[dict[str, Any]]:
    lowrank, other = _split_params(model)
    if not lowrank:
        raise ValueError(
            "APOLLO: no 2-D weight matrices found to project — refusing to "
            "train without a projected APOLLO group."
        )

    return [
        {
            "params": other,
            "weight_decay": weight_decay,
        },
        {
            "params": lowrank,
            "weight_decay": weight_decay,
            "rank": recipe.rank,
            "scale": recipe.scale,
            "scale_type": recipe.scale_type,
            "update_proj_gap": recipe.update_proj_gap,
            "proj": recipe.proj,
            "proj_type": recipe.proj_type,
        },
    ]


# Upstream apollo-torch (apollo_torch/apollo.py:140) initializes the optimizer
# moments via `torch.zeros_like(grad)`, so under FSDP `mixed_precision=bf16`
# the running averages live in bf16. The APOLLO paper uses fp32 moments —
# bf16 mantissa is 7 bits, so `exp_avg.mul_(0.9).add_(grad, alpha=0.1)` loses
# the accumulated gradient roughly an order of magnitude faster than fp32.
# `_FP32MomentsAPOLLO` pre-creates the moments in fp32 before upstream's
# `if "exp_avg" not in state` block fires; subsequent in-place ops promote
# the bf16 grad operand to fp32 implicitly.
def _make_fp32_moments_apollo_class() -> type:
    from apollo_torch import APOLLOAdamW

    class _FP32MomentsAPOLLO(APOLLOAdamW):
        @torch.no_grad()
        def step(self, closure=None):
            for group in self.param_groups:
                for p in group["params"]:
                    if p.grad is None:
                        continue
                    state = self.state[p]
                    if "exp_avg" in state:
                        continue
                    if "step" not in state:
                        state["step"] = 0
                    grad = p.grad
                    if "rank" in group:
                        if "projector" not in state:
                            state["projector"] = self._initialize_projector(group, state)
                        grad = state["projector"].project(grad, state["step"])
                    state["exp_avg"] = torch.zeros_like(grad, dtype=torch.float32)
                    state["exp_avg_sq"] = torch.zeros_like(grad, dtype=torch.float32)
            return super().step(closure)

    return _FP32MomentsAPOLLO


def build_apollo_optimizer(
    model: nn.Module,
    *,
    lr: float,
    weight_decay: float,
    rank: int = 256,
    scale: float = 1.0,
    update_proj_gap: int = 200,
    proj_type: str = "std",
    scale_type: str = "channel",
    proj: str = "random",
    betas: tuple[float, float] = (0.9, 0.999),
    eps: float = 1e-8,
) -> torch.optim.Optimizer:
    """Full APOLLO (channel-wise scaling, rank-256 by default)."""

    OptCls = _make_fp32_moments_apollo_class()
    recipe = _ApolloRecipe(
        rank=rank,
        scale=scale,
        scale_type=scale_type,
        update_proj_gap=update_proj_gap,
        proj=proj,
        proj_type=proj_type,
        scale_front=_APOLLO_DEFAULT.scale_front,
        disable_nl=_APOLLO_DEFAULT.disable_nl,
    )
    param_groups = _build_param_groups(
        model, weight_decay=weight_decay, recipe=recipe
    )
    return OptCls(
        param_groups,
        lr=lr,
        betas=betas,
        eps=eps,
        weight_decay=weight_decay,
        scale_front=recipe.scale_front,
        disable_nl=recipe.disable_nl,
    )


def build_apollo_mini_optimizer(
    model: nn.Module,
    *,
    lr: float,
    weight_decay: float,
    betas: tuple[float, float] = (0.9, 0.999),
    eps: float = 1e-8,
) -> torch.optim.Optimizer:
    """APOLLO-Mini: rank-1 tensor-wise scaling (smallest optimizer state)."""

    OptCls = _make_fp32_moments_apollo_class()
    param_groups = _build_param_groups(
        model, weight_decay=weight_decay, recipe=_APOLLO_MINI,
    )
    return OptCls(
        param_groups,
        lr=lr,
        betas=betas,
        eps=eps,
        weight_decay=weight_decay,
        scale_front=_APOLLO_MINI.scale_front,
        disable_nl=_APOLLO_MINI.disable_nl,
    )


def _build_param_groups_from_lists(
    lowrank: list[nn.Parameter], other: list[nn.Parameter],
    *, weight_decay: float, recipe: _ApolloRecipe,
) -> list[dict[str, Any]]:
    """Build APOLLO param groups from pre-classified parameter lists.

    Used when the model has been wrapped by FSDP and shape-based detection
    via `_split_params` no longer works (FSDP1 returns 1-D FlatParameters
    even with `use_orig_params=True` on this PyTorch build). Caller must
    classify on the unwrapped model and pass the lists here.
    """
    if not lowrank:
        raise ValueError(
            "APOLLO: empty lowrank list — caller's pre-classification "
            "found no 2-D weights."
        )
    return [
        {"params": other, "weight_decay": weight_decay},
        {
            "params": lowrank,
            "weight_decay": weight_decay,
            "rank": recipe.rank,
            "scale": recipe.scale,
            "scale_type": recipe.scale_type,
            "update_proj_gap": recipe.update_proj_gap,
            "proj": recipe.proj,
            "proj_type": recipe.proj_type,
        },
    ]


def build_apollo_optimizer_from_groups(
    lowrank: list[nn.Parameter], other: list[nn.Parameter],
    *, lr: float, weight_decay: float,
    rank: int = 256, scale: float = 1.0,
    update_proj_gap: int = 200, proj_type: str = "std",
    scale_type: str = "channel", proj: str = "random",
    betas: tuple[float, float] = (0.9, 0.999), eps: float = 1e-8,
) -> torch.optim.Optimizer:
    """Full APOLLO with caller-provided param-group classification (FSDP-safe)."""
    OptCls = _make_fp32_moments_apollo_class()
    recipe = _ApolloRecipe(
        rank=rank, scale=scale, scale_type=scale_type,
        update_proj_gap=update_proj_gap, proj=proj, proj_type=proj_type,
        scale_front=_APOLLO_DEFAULT.scale_front,
        disable_nl=_APOLLO_DEFAULT.disable_nl,
    )
    param_groups = _build_param_groups_from_lists(
        lowrank, other, weight_decay=weight_decay, recipe=recipe,
    )
    return OptCls(
        param_groups, lr=lr, betas=betas, eps=eps,
        weight_decay=weight_decay,
        scale_front=recipe.scale_front, disable_nl=recipe.disable_nl,
    )


def build_apollo_mini_optimizer_from_groups(
    lowrank: list[nn.Parameter], other: list[nn.Parameter],
    *, lr: float, weight_decay: float,
    betas: tuple[float, float] = (0.9, 0.999), eps: float = 1e-8,
) -> torch.optim.Optimizer:
    """APOLLO-Mini with caller-provided param-group classification (FSDP-safe)."""
    OptCls = _make_fp32_moments_apollo_class()
    param_groups = _build_param_groups_from_lists(
        lowrank, other, weight_decay=weight_decay, recipe=_APOLLO_MINI,
    )
    return OptCls(
        param_groups, lr=lr, betas=betas, eps=eps,
        weight_decay=weight_decay,
        scale_front=_APOLLO_MINI.scale_front,
        disable_nl=_APOLLO_MINI.disable_nl,
    )


def optimizer_state_bytes(opt: torch.optim.Optimizer) -> int:
    """Sum of bytes occupied by tensors in `opt.state` (after at least one step)."""

    total = 0
    for state in opt.state.values():
        for v in state.values():
            if isinstance(v, torch.Tensor):
                total += v.numel() * v.element_size()
    return total


# Short aliases for callers/tests that prefer the bare APOLLO name.
build_apollo = build_apollo_optimizer
build_apollo_mini = build_apollo_mini_optimizer

__all__ = [
    "_NON_LOWRANK_NAME_HINTS",
    "build_apollo",
    "build_apollo_mini",
    "build_apollo_optimizer",
    "build_apollo_mini_optimizer",
    "build_apollo_optimizer_from_groups",
    "build_apollo_mini_optimizer_from_groups",
    "optimizer_state_bytes",
]
