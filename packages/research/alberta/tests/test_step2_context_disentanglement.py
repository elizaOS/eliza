"""Smoke tests for the Step 2 context disentanglement experiment."""

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
    / "step2_context_disentanglement.py"
)


def load_experiment_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_context_disentanglement")


def test_context_indexed_probe_solves_context_conflict():
    module = load_experiment_module()
    contexts = np.arange(240, dtype=np.int32) % 2
    features = np.ones((240, 1), dtype=np.float32)
    targets = np.where(contexts[:, None] == 0, 1.0, -1.0).astype(np.float32)

    hidden_loss = module.run_linear_probe(
        features,
        targets,
        contexts,
        n_contexts=2,
        step_size=0.1,
        mode="hidden_single",
    )
    indexed_loss = module.run_linear_probe(
        features,
        targets,
        contexts,
        n_contexts=2,
        step_size=0.1,
        mode="context_indexed",
    )

    assert float(np.mean(indexed_loss[-40:])) < 0.05
    assert float(np.mean(hidden_loss[-40:])) > 0.8


def test_context_gated_slope_probe_separates_bias_from_feature_use():
    module = load_experiment_module()
    contexts = np.tile(np.array([0, 0, 1, 1], dtype=np.int32), 120)
    features = np.tile(np.array([[-1.0], [1.0], [-1.0], [1.0]], dtype=np.float32), (120, 1))
    targets = np.where(contexts[:, None] == 0, features, -features).astype(np.float32)

    bias_only_loss = module.run_linear_probe(
        features,
        targets,
        contexts,
        n_contexts=2,
        step_size=0.1,
        mode="observable_single",
    )
    gated_slope_loss = module.run_linear_probe(
        features,
        targets,
        contexts,
        n_contexts=2,
        step_size=0.1,
        mode="context_gated_slopes",
    )

    assert float(np.mean(gated_slope_loss[-80:])) < 0.02
    assert float(np.mean(bias_only_loss[-80:])) > 0.8


def test_run_suite_tiny_smoke():
    module = load_experiment_module()
    config = module.ExperimentConfig(
        num_steps=48,
        seeds=1,
        feature_dim=5,
        n_tasks=2,
        n_contexts=3,
        context_length=8,
        active_pairs=1,
        noise_std=0.0,
        n_features=4,
        candidate_count=10,
        replacement_interval=8,
        min_feature_age=4,
        candidate_min_age=2,
    )

    results = module.run_suite(config)

    assert len(results["rows"]) == 12
    assert len(results["construction_diagnostics"]) == 1
    assert set(results["aggregate"]) == {
        "learned_augmented:context_indexed",
        "learned_augmented:context_gated_slopes",
        "learned_augmented:hidden_single",
        "learned_augmented:observable_single",
        "oracle_augmented:context_indexed",
        "oracle_augmented:context_gated_slopes",
        "oracle_augmented:hidden_single",
        "oracle_augmented:observable_single",
        "raw:context_indexed",
        "raw:context_gated_slopes",
        "raw:hidden_single",
        "raw:observable_single",
    }
    for row in results["rows"]:
        assert np.isfinite(row["final_window_loss"])
        assert np.isfinite(row["last_cycle_loss"])
