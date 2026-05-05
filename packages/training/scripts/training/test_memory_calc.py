"""Smoke tests for the memory calculator. CPU-only."""

from __future__ import annotations

import pytest

from scripts.training.memory_calc import (
    GB,
    HARDWARE,
    SHAPES,
    InferConfig,
    KvKQuant,
    KvVQuant,
    TrainConfig,
    TrainOpt,
    WeightQuant,
    estimate_infer,
    estimate_train,
    estimate_train_seconds,
    fits_on,
    max_context_for,
)


def test_shapes_match_eliza_1_series() -> None:
    # Three production sizes plus the qwen3-0.6b smoke key consumed by
    # smoke_full_stack.sh and resolved by scripts/preflight.sh.
    assert {"qwen3.5-2b", "qwen3.5-9b", "qwen3.6-27b"} <= set(SHAPES)
    assert "qwen3-0.6b" in SHAPES, "smoke key missing from SHAPES"


def test_train_2b_under_24gb_at_8k() -> None:
    # Registry budget (15.5 GB) is what `instrumentation.py` enforces against
    # `torch.cuda.max_memory_reserved`; the calculator's prediction is more
    # conservative because it also counts ~2 GB of NCCL/framework workspace
    # and bf16 gradients separately from weights. We only assert here that
    # the prediction is in the right ballpark for the local tier.
    cfg = TrainConfig(
        seq_len=8192,
        optimizer=TrainOpt.APOLLO_MINI,
        use_liger=True,
        use_grad_checkpointing=True,
        use_flash_attn=True,
    )
    b = estimate_train(SHAPES["qwen3.5-2b"], cfg)
    assert 0 < b.total_gb < 24.0, (
        f"qwen3.5-2b @ seq=8k predicted {b.total_gb:.2f} GB; >24 GB drifts"
        " away from the local tier."
    )


def test_train_27b_needs_2xh200() -> None:
    cfg = TrainConfig(
        seq_len=147_456,
        optimizer=TrainOpt.APOLLO_MINI,
        fsdp_world_size=2,
        use_liger=True,
        use_grad_checkpointing=True,
        use_flash_attn=True,
    )
    b = estimate_train(SHAPES["qwen3.6-27b"], cfg)
    ok, util = fits_on(b, hw="h200-141", headroom_pct=5.0)
    assert ok, f"27B 2xH200 should fit, got {b.total_gb:.1f} GB ({util:.0f}% util)"


def test_infer_27b_full_quant_under_24gb_at_144k() -> None:
    s = SHAPES["qwen3.6-27b"]
    cfg = InferConfig(
        seq_in=131_072, seq_out=16_384,
        weight_quant=WeightQuant.POLARQUANT_Q4,
        kv_k_quant=KvKQuant.QJL_1BIT,
        kv_v_quant=KvVQuant.TURBOQUANT_Q4,
    )
    b = estimate_infer(s, cfg)
    assert b.total_gb < 24.0, (
        f"27B fully-quantized inference at 144k should fit under 24 GB, got {b.total_gb:.2f}"
    )


def test_max_context_27b_fits_1m_on_blackwell_6000() -> None:
    max_seq, _ = max_context_for("qwen3.6-27b", hw="rtx-pro-6000-blackwell")
    assert max_seq >= 1_048_576


@pytest.mark.parametrize("hw", ["h200-141", "h100-80", "rtx-pro-6000-blackwell"])
def test_estimate_train_seconds_returns_positive(hw: str) -> None:
    secs, meta = estimate_train_seconds(
        "qwen3.6-27b", hw=hw, world_size=2, n_tokens=1_000_000_000,
    )
    assert secs > 0
    assert meta["wall_hours"] == pytest.approx(secs / 3600, rel=1e-6)
    assert meta["realized_pflops_per_s"] > 0


def test_unknown_hw_raises() -> None:
    with pytest.raises(KeyError):
        estimate_train_seconds(
            "qwen3.5-2b", hw="not-a-real-gpu", world_size=1, n_tokens=1_000_000,
        )


def test_hardware_keys_cover_all_targets() -> None:
    needed = {"h200-141", "h100-80", "rtx-pro-6000-blackwell", "rtx-5090"}
    assert needed.issubset(HARDWARE.keys())


def test_breakdown_total_matches_sum() -> None:
    s = SHAPES["qwen3.5-2b"]
    cfg = TrainConfig(seq_len=4096)
    b = estimate_train(s, cfg)
    expected = (
        b.weights_gb + b.gradients_gb + b.optimizer_state_gb
        + b.activations_gb + b.logits_transient_gb
        + b.kv_cache_gb + b.misc_gb
    )
    assert b.total_gb == pytest.approx(expected, rel=1e-9)


def test_gb_constant() -> None:
    assert GB == 1024 ** 3
