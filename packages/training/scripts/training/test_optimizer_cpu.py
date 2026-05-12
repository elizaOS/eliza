"""CPU-friendly smoke tests for the APOLLO optimizer factories.

The full GPU-bound integration test lives in `test_apollo.py` (loads a real
Qwen on CUDA). This file pins the small invariants we can verify without
a GPU: param-group classification, optimizer-state shrinkage on a tiny
synthetic model, and `optimizer_state_bytes` correctness.

Marked with `gpu` for any test that really needs CUDA so they skip cleanly.
"""

from __future__ import annotations

import pytest

import torch
from torch import nn

from scripts.training.optimizer import (
    _NON_LOWRANK_NAME_HINTS,
    build_apollo_mini_optimizer,
    build_apollo_optimizer,
    optimizer_state_bytes,
)


class _TinyLM(nn.Module):
    """Toy LM-shaped module: embedding + linear stack + lm_head + norm."""

    def __init__(self, vocab: int = 64, hidden: int = 32, n_layers: int = 2):
        super().__init__()
        self.embed = nn.Embedding(vocab, hidden)
        self.layers = nn.ModuleList(
            [nn.Linear(hidden, hidden) for _ in range(n_layers)]
        )
        self.norm = nn.LayerNorm(hidden)
        self.lm_head = nn.Linear(hidden, vocab, bias=False)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        x = self.embed(ids)
        for layer in self.layers:
            x = layer(x)
        x = self.norm(x)
        return self.lm_head(x)


def _step_once(model: nn.Module, opt: torch.optim.Optimizer) -> None:
    ids = torch.randint(0, 64, (2, 4))
    logits = model(ids)
    loss = logits.sum()
    loss.backward()
    opt.step()
    opt.zero_grad(set_to_none=True)


def test_non_lowrank_hints_cover_embed_and_head() -> None:
    assert "embed" in _NON_LOWRANK_NAME_HINTS
    assert "lm_head" in _NON_LOWRANK_NAME_HINTS
    assert "norm" in _NON_LOWRANK_NAME_HINTS


def test_apollo_optimizer_routes_2d_weights() -> None:
    pytest.importorskip("apollo_torch")
    model = _TinyLM()
    opt = build_apollo_optimizer(model, lr=1e-3, weight_decay=0.0)
    groups = opt.param_groups
    assert len(groups) == 2
    other, lowrank = groups
    assert "rank" in lowrank and "rank" not in other
    # Linear weights should be in the lowrank group; embed/lm_head/norm should not.
    lowrank_ids = {id(p) for p in lowrank["params"]}
    for layer in model.layers:
        assert id(layer.weight) in lowrank_ids
    assert id(model.embed.weight) not in lowrank_ids
    assert id(model.lm_head.weight) not in lowrank_ids


def test_apollo_mini_state_smaller_than_full_apollo() -> None:
    pytest.importorskip("apollo_torch")
    torch.manual_seed(0)

    def fresh() -> _TinyLM:
        torch.manual_seed(0)
        return _TinyLM(hidden=64, n_layers=4)

    m_b = fresh()
    opt_b = build_apollo_optimizer(m_b, lr=1e-3, weight_decay=0.0, rank=8)
    _step_once(m_b, opt_b)
    bytes_apollo = optimizer_state_bytes(opt_b)

    m_c = fresh()
    opt_c = build_apollo_mini_optimizer(m_c, lr=1e-3, weight_decay=0.0)
    _step_once(m_c, opt_c)
    bytes_mini = optimizer_state_bytes(opt_c)

    assert bytes_apollo > 0 and bytes_mini > 0
    assert bytes_mini < bytes_apollo, (
        f"APOLLO-Mini state {bytes_mini} should be < APOLLO {bytes_apollo}"
    )


@pytest.mark.parametrize("builder_name", ["apollo", "apollo_mini"])
def test_apollo_step_decreases_loss_on_synthetic_problem(builder_name: str) -> None:
    """An APOLLO / APOLLO-Mini optimizer step must actually reduce a tiny
    cross-entropy loss — the projector + norm-growth scaling is a no-op proxy
    for AdamW only if the update direction is right. Fixed-input, fixed-target
    overfit: 30 steps on a 2-layer toy LM, loss must drop monotonically enough
    to land well below the starting value."""
    pytest.importorskip("apollo_torch")
    torch.manual_seed(0)
    model = _TinyLM(vocab=32, hidden=48, n_layers=2)
    ids = torch.randint(0, 32, (4, 6))
    target = torch.randint(0, 32, (4, 6))

    if builder_name == "apollo":
        opt = build_apollo_optimizer(model, lr=5e-3, weight_decay=0.0, rank=8)
    else:
        opt = build_apollo_mini_optimizer(model, lr=5e-3, weight_decay=0.0)

    def ce() -> torch.Tensor:
        logits = model(ids)  # (B, S, V)
        return nn.functional.cross_entropy(
            logits.reshape(-1, logits.size(-1)), target.reshape(-1)
        )

    start = ce().item()
    last = start
    for _ in range(30):
        opt.zero_grad(set_to_none=True)
        loss = ce()
        loss.backward()
        opt.step()
        last = loss.item()
    assert last < start, f"{builder_name}: loss did not decrease ({start:.4f} -> {last:.4f})"
    assert last < start * 0.7, (
        f"{builder_name}: loss only dropped {start:.4f} -> {last:.4f}; "
        "expected the synthetic overfit to fall below 70% of the start"
    )


def test_apollo_refuses_when_no_2d_weights() -> None:
    pytest.importorskip("apollo_torch")

    class OnlyNorm(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.norm = nn.LayerNorm(8)

    with pytest.raises(ValueError, match="no 2-D weight matrices"):
        build_apollo_optimizer(OnlyNorm(), lr=1e-3, weight_decay=0.0)
