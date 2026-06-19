"""Smoke tests for the Step 2 theory falsification runner."""

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
    / "step2_theory_falsification.py"
)


def load_module() -> ModuleType:
    return load_script(_SCRIPT_PATH, "step2_theory_falsification")


def test_expand_scenarios_all() -> None:
    """The all selector covers every registered stress case."""
    module = load_module()

    assert module.expand_scenarios("all") == module.SCENARIOS


def test_generate_stream_shapes_and_metadata() -> None:
    """Generated streams have aligned online observations and targets."""
    module = load_module()

    for scenario in module.SCENARIOS:
        stream = module.generate_stream(scenario, steps=24, seed=0)

        assert stream.name == scenario
        assert stream.observations.shape[0] == 24
        assert stream.targets.shape[0] == 24
        assert stream.targets.ndim == 2
        assert stream.limitation
        assert stream.hidden_assumption
        assert np.isfinite(stream.observations).all()
        assert np.isfinite(stream.targets).all()


def test_requested_adversarial_scenarios_are_registered() -> None:
    """The T2 runner covers the requested universal-claim falsifiers."""
    module = load_module()

    assert set(module.SCENARIOS) == {
        "delayed_parity",
        "hidden_context_aliasing",
        "adversarial_nonstationary_oos",
        "rotating_relevant_subspace",
        "class_blocked_discontinuous_shift",
        "sparse_rare_feature_utility",
    }


def test_run_suite_smoke() -> None:
    """A tiny run exercises the learner loop and summary path."""
    module = load_module()
    methods = (
        module.MethodSpec("target_structure_upgd", "upgd", (4,)),
        module.MethodSpec("mlp4", "mlp", (4,)),
    )

    payload = module.run_suite(("hidden_context_aliasing",), methods, steps=8, seeds=1)

    assert len(payload["records"]) == 1
    row = payload["summary"]["hidden_context_aliasing"]
    assert set(row) == {"diff_positive_favors_upgd", "wins", "losses", "ties"}


def test_context_and_fastslow_methods_smoke() -> None:
    """New UPGD variants should run through the same falsification loop."""
    module = load_module()
    methods = module.method_specs(
        "upgd,upgd_context,upgd_context_dense,upgd_context_phase_only,upgd_fastslow,mlp",
        upgd_width=4,
        mlp_width=4,
    )

    payload = module.run_suite(("rotating_relevant_subspace",), methods, steps=8, seeds=1)

    names = set(payload["records"][0]["methods"])
    assert "target_structure_upgd_context" in names
    assert "target_structure_upgd_context_dense" in names
    assert "target_structure_upgd_context_phase_only" in names
    assert "target_structure_upgd_fastslow" in names
