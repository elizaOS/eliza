"""Smoke tests for the Direction 6 context inference script."""

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
    / "step2_context_inference.py"
)


def load_script_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_context_inference")


def test_phase_inferred_matches_oracle_when_phase_is_aligned() -> None:
    module = load_script_module()
    features = np.ones((120, 1), dtype=np.float32)
    contexts = ((np.arange(120) // 10) % 2).astype(np.int32)
    targets = np.where(contexts[:, None] == 0, 1.0, -1.0).astype(np.float32)

    oracle = module.run_oracle_context_gated_probe(
        features,
        targets,
        contexts,
        n_contexts=2,
        step_size=0.2,
    )
    inferred, assignments = module.run_phase_inferred_context_probe(
        features,
        targets,
        n_experts=2,
        context_length=10,
        step_size=0.2,
    )

    assert np.array_equal(assignments, contexts)
    assert np.allclose(inferred, oracle)
    assert float(np.mean(inferred[-20:])) < 0.05


def test_residual_inferred_probe_returns_finite_curves() -> None:
    module = load_script_module()
    features = np.tile(np.array([[1.0], [-1.0]], dtype=np.float32), (40, 1))
    targets = features.copy()

    losses, assignments, allocated = module.run_inferred_context_probe(
        features,
        targets,
        n_experts=2,
        step_size=0.1,
        min_dwell=2,
        switch_margin=0.8,
        new_expert_margin=0.95,
        novelty_margin=2.0,
        min_novelty_loss=0.01,
        ema_decay=0.9,
    )

    assert losses.shape == (80,)
    assert assignments.shape == (80,)
    assert allocated.shape == (80,)
    assert np.all(np.isfinite(losses))


def test_run_suite_tiny_smoke() -> None:
    module = load_script_module()
    config = module.ExperimentConfig(
        num_steps=80,
        seeds=1,
        feature_dim=5,
        n_tasks=2,
        n_contexts=2,
        context_length=20,
        active_pairs=1,
        noise_std=0.0,
        inference_mode="phase",
    )

    results = module.run_suite(config)

    assert {row["method"] for row in results["rows"]} == {
        "hidden_single",
        "inferred_context",
        "oracle_context_gated",
    }
    assert results["aggregate"]["gain_summary"]["improves_hidden_single"] in {
        True,
        False,
    }
    for row in results["rows"]:
        assert np.isfinite(row["last_cycle_loss"])
