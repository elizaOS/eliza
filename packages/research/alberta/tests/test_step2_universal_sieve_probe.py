"""Tests for the compact Step 2 universal sieve probe."""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
from conftest import load_script

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "step2_universal_sieve_probe.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_universal_sieve_probe")


def test_all_target_families_are_finite_and_nonconstant() -> None:
    module = load_module()
    x = module.make_inputs(seed=0, steps=128, feature_dim=6)

    for family in module.FAMILY_NAMES:
        y = module.raw_targets(family, x)
        assert y.shape == (128,)
        assert np.isfinite(y).all()
        assert float(np.std(y)) > 0.01


def test_capacity_trend_detects_material_improvement() -> None:
    module = load_module()
    config = module.ProbeConfig(capacities=(8, 16, 32), material_improvement_ratio=0.10)
    rows = [
        {"capacity": 8, "final_window_mse": 1.00},
        {"capacity": 8, "final_window_mse": 1.10},
        {"capacity": 16, "final_window_mse": 0.90},
        {"capacity": 16, "final_window_mse": 0.95},
        {"capacity": 32, "final_window_mse": 0.70},
        {"capacity": 32, "final_window_mse": 0.75},
    ]

    trend = module.summarize_capacity_trend(rows, config.capacities, config)

    assert trend["monotone_with_tolerance"] is True
    assert trend["materially_improves"] is True
    assert trend["best_capacity"] == 32


def test_smoke_probe_runs_and_writes_outputs(tmp_path: Path) -> None:
    module = load_module()
    config = module.ProbeConfig(
        steps=40,
        n_seeds=1,
        final_window=10,
        capacities=(4, 8),
        noise_std=0.0,
    )

    results = module.run_probe(config)
    module.write_outputs(results, tmp_path)

    assert "support_summary" in results["aggregate"]
    assert "polynomial" in results["aggregate"]
    assert "upgd" in results["aggregate"]["polynomial"]
    assert "mlp" in results["aggregate"]["polynomial"]
    assert "| family | learner | h=4 | h=8 |" in results["result_table"]
    assert (tmp_path / "results.json").exists()
    assert (tmp_path / "SUMMARY.md").exists()
