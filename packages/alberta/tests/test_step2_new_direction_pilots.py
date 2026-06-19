"""Tests for the Step 2 new-direction pilot helpers."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
import pytest
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_new_direction_pilots.py"
)


def load_pilots_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_new_direction_pilots")


def test_hedge_curve_tracks_persistent_low_loss_expert() -> None:
    """Hedge should quickly concentrate on a persistently better expert."""
    pilots = load_pilots_module()
    seed_curves = {
        "fair_mlp": np.ones(8, dtype=np.float32),
        "winner": np.full(8, 0.1, dtype=np.float32),
    }

    curve = pilots.hedge_curve(
        seed_curves,
        ("fair_mlp", "winner"),
        eta=5.0,
        discount=1.0,
    )

    assert curve.shape == (8,)
    assert curve[0] == pytest.approx(0.55)
    assert curve[-1] < 0.11


def test_ema_gated_curve_uses_prior_loss_state() -> None:
    """The gate is causal: step t only uses EMA state from earlier steps."""
    pilots = load_pilots_module()
    baseline = np.ones(5, dtype=np.float32)
    candidate = np.asarray([2.0, 2.0, 0.1, 0.1, 0.1], dtype=np.float32)

    curve = pilots.ema_gated_curve(baseline, candidate, decay=0.5)

    assert curve[0] == pytest.approx(candidate[0])
    assert curve[1] == pytest.approx(baseline[1])
    assert curve.shape == baseline.shape


def test_portfolio_curves_are_registered() -> None:
    """Portfolio helper names must match the reported method table."""
    pilots = load_pilots_module()
    seed_curves = {
        method: np.full(4, 1.0 + idx, dtype=np.float32)
        for idx, method in enumerate(pilots.BASE_METHODS)
    }

    curves = pilots.portfolio_curves(seed_curves, pilots.PilotConfig(num_steps=4))

    assert set(curves) == {
        "portfolio_all_hedge",
        "portfolio_signal_hedge",
        "portfolio_signal_ema_gate",
    }
    assert set(curves).issubset(pilots.METHOD_STATUS)
