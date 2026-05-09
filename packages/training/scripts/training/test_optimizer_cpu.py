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


def test_apollo_refuses_when_no_2d_weights() -> None:
    pytest.importorskip("apollo_torch")

    class OnlyNorm(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.norm = nn.LayerNorm(8)

    with pytest.raises(ValueError, match="no 2-D weight matrices"):
        build_apollo_optimizer(OnlyNorm(), lr=1e-3, weight_decay=0.0)
