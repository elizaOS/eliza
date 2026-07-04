"""CPU-only tests for the post-step finite-weights guard.

The guard (`assert_finite_step` / `FiniteWeightsCallback`) is the generic
insurance against the class of bug that produced an all-NaN 12B checkpoint:
a training run that NaNs out but still reports "complete" and saves dead
weights. These tests inject a NaN into a tiny synthetic model and assert the
guard raises, naming the offending tensor — no GPU, no real checkpoint.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

import torch
from torch import nn

from scripts.training.instrumentation import (
    FiniteWeightsCallback,
    InstrumentationConfig,
    assert_finite_checkpoint,
    assert_finite_loss,
    assert_finite_step,
    make_finite_weights_callback,
    make_hf_callback,
)


class _TinyLM(nn.Module):
    """Toy LM-shaped module: embedding + linear stack + lm_head + norm.

    Mirrors the `_TinyLM` in test_apollo_default.py / test_optimizer_cpu.py so
    the guard is exercised against the same param shapes the real path sees.
    """

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


@dataclass
class _FakeState:
    global_step: int


def test_passes_on_finite_weights() -> None:
    model = _TinyLM()
    # No exception on healthy weights.
    assert_finite_step(model, step=10)


def test_passes_on_finite_loss() -> None:
    assert_finite_loss(torch.tensor(0.1234), context="unit-test loss")


def test_raises_on_nan_loss() -> None:
    with pytest.raises(RuntimeError, match="non-finite .*unit-test loss"):
        assert_finite_loss(torch.tensor(float("nan")), context="unit-test loss")


def test_raises_on_inf_loss_vector() -> None:
    loss = torch.tensor([0.1, float("inf"), float("nan")])
    with pytest.raises(RuntimeError, match="2/3 non-finite"):
        assert_finite_loss(loss, context="vector loss")


def test_checkpoint_scan_passes_on_finite_torch_shard(tmp_path) -> None:
    ckpt = tmp_path / "final"
    ckpt.mkdir()
    torch.save({"model.layers.0.weight": torch.ones(2, 3)}, ckpt / "pytorch_model.bin")

    result = assert_finite_checkpoint(ckpt)

    assert result["passed"] is True
    assert result["tensor_files"] == 1
    assert result["tensors"] == 1


def test_checkpoint_scan_raises_on_non_finite_torch_shard(tmp_path) -> None:
    ckpt = tmp_path / "final"
    ckpt.mkdir()
    torch.save(
        {"model.layers.0.weight": torch.tensor([[1.0, float("nan")]])},
        ckpt / "pytorch_model.bin",
    )

    with pytest.raises(RuntimeError, match="pytorch_model.bin:model.layers.0.weight"):
        assert_finite_checkpoint(ckpt)


def test_checkpoint_scan_requires_tensor_shards(tmp_path) -> None:
    ckpt = tmp_path / "final"
    ckpt.mkdir()
    (ckpt / "config.json").write_text("{}", encoding="utf-8")

    with pytest.raises(RuntimeError, match="no tensor shards"):
        assert_finite_checkpoint(ckpt)


def test_raises_on_nan_weight() -> None:
    model = _TinyLM()
    with torch.no_grad():
        model.layers[1].weight[0, 0] = float("nan")
    with pytest.raises(RuntimeError, match="non-finite"):
        assert_finite_step(model, step=20)


def test_raises_on_inf_weight() -> None:
    model = _TinyLM()
    with torch.no_grad():
        model.lm_head.weight[3, 5] = float("inf")
    with pytest.raises(RuntimeError, match="non-finite"):
        assert_finite_step(model, step=30)


def test_error_names_offending_tensor() -> None:
    model = _TinyLM()
    with torch.no_grad():
        model.norm.weight[2] = float("nan")
    with pytest.raises(RuntimeError, match="norm.weight"):
        assert_finite_step(model, step=40)


def test_error_names_multiple_offenders_and_step() -> None:
    model = _TinyLM()
    with torch.no_grad():
        model.embed.weight[0, 0] = float("nan")
        model.lm_head.weight[0, 0] = float("nan")
    with pytest.raises(RuntimeError) as exc:
        assert_finite_step(model, step=77)
    msg = str(exc.value)
    assert "embed.weight" in msg
    assert "lm_head.weight" in msg
    assert "step 77" in msg


def test_ignores_frozen_parameters() -> None:
    """A non-finite value in a frozen (requires_grad=False) parameter is not a
    training-divergence signal — the guard only inspects trainable weights."""
    model = _TinyLM()
    model.embed.weight.requires_grad_(False)
    with torch.no_grad():
        model.embed.weight[0, 0] = float("nan")
    # Trainable params are still finite → no raise.
    assert_finite_step(model, step=50)


def test_callback_fires_on_logging_interval() -> None:
    """FiniteWeightsCallback only checks on the configured interval, and raises
    when a checked step finds a NaN."""
    cb = FiniteWeightsCallback(check_every_steps=10)
    model = _TinyLM()
    with torch.no_grad():
        model.layers[0].weight[1, 1] = float("nan")

    # Off-interval step: guard is skipped, no raise even though NaN present.
    cb.on_step_end(None, _FakeState(global_step=7), None, model=model)

    # On-interval step: guard fires.
    with pytest.raises(RuntimeError, match="non-finite"):
        cb.on_step_end(None, _FakeState(global_step=10), None, model=model)


def test_callback_passes_when_weights_finite() -> None:
    cb = FiniteWeightsCallback(check_every_steps=5)
    model = _TinyLM()
    # Healthy model on an on-interval step → no raise.
    cb.on_step_end(None, _FakeState(global_step=5), None, model=model)


def test_callback_deduplicates_repeated_step() -> None:
    """The same global_step handed twice is only checked once (mirrors the
    InstrumentationCallback pattern of skipping repeated steps)."""
    cb = FiniteWeightsCallback(check_every_steps=1)
    model = _TinyLM()
    cb.on_step_end(None, _FakeState(global_step=3), None, model=model)
    # Inject NaN, then re-send the SAME step — the guard skips it as already seen.
    with torch.no_grad():
        model.layers[0].weight[0, 0] = float("nan")
    cb.on_step_end(None, _FakeState(global_step=3), None, model=model)
    # Advancing to a new checked step catches it.
    with pytest.raises(RuntimeError, match="non-finite"):
        cb.on_step_end(None, _FakeState(global_step=4), None, model=model)


def test_make_finite_weights_callback_requires_transformers() -> None:
    """The TrainerCallback factory needs transformers; when present it returns a
    callback that IS a TrainerCallback and still hard-fails on NaN.

    Also guards the MRO: TrainerCallback.on_step_end is a real no-op override,
    so the concrete callback must resolve OUR on_step_end, not the base's — a
    reversed base order would silently shadow the guard.
    """
    transformers = pytest.importorskip("transformers")
    cb = make_finite_weights_callback(check_every_steps=1)
    assert isinstance(cb, transformers.TrainerCallback)
    # The guard's on_step_end must win the MRO, not the base no-op.
    assert type(cb).on_step_end is FiniteWeightsCallback.on_step_end
    model = _TinyLM()
    with torch.no_grad():
        model.lm_head.weight[0, 0] = float("nan")
    with pytest.raises(RuntimeError, match="non-finite"):
        cb.on_step_end(None, _FakeState(global_step=1), None, model=model)


def test_make_hf_callback_instrumentation_hooks_win_mro() -> None:
    """Regression: the instrumentation callback's on_step_end / on_train_begin /
    on_train_end must resolve to InstrumentationCallback, not the base
    TrainerCallback no-ops — otherwise the memory-budget breach guard and the
    tokens/sec trace silently never fire."""
    pytest.importorskip("transformers")
    from scripts.training.instrumentation import InstrumentationCallback

    cb = make_hf_callback(
        InstrumentationConfig(
            out_dir="/tmp/eliza-finite-guard-mro-test",
            seq_len=8,
            effective_batch_size=1,
            memory_budget_gb=1.0,
        )
    )
    for hook in ("on_step_end", "on_train_begin", "on_train_end"):
        assert getattr(type(cb), hook) is getattr(InstrumentationCallback, hook), (
            f"{hook} resolves to the base TrainerCallback no-op — the "
            "instrumentation guard would never fire"
        )
