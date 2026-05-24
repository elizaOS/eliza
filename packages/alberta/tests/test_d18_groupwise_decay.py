"""Tests for D18's target-geometry-conditioned basis decay."""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from types import ModuleType

import numpy as np
from conftest import load_script

_D15_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "new_directions"
    / "d15_groupwise_basis_lms.py"
)
_D18_SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "examples"
    / "The Alberta Plan"
    / "Step2"
    / "new_directions"
    / "d18_simple_universal_resource_basis.py"
)


def load_d15_module() -> ModuleType:
    return load_script(_D15_SCRIPT_PATH, "d15_groupwise_basis_lms")


def load_d18_module() -> ModuleType:
    return load_script(_D18_SCRIPT_PATH, "d18_simple_universal_resource_basis")


def test_simplex_decay_uses_raw_decay_target() -> None:
    """One-hot raw targets can override readout decay without changing updates."""
    d15 = load_d15_module()
    config = d15.GroupwiseConfig(
        name="test",
        input_clip=5.0,
        poly_max_dim=1,
        fourier_max_dim=1,
        fourier_frequencies=(1.0,),
        tanh_width=1,
        tanh_weight_scale=1.0,
        poly_step_size=0.0,
        fourier_step_size=0.0,
        tanh_step_size=0.0,
        poly_scale=1.0,
        fourier_scale=1.0,
        tanh_scale=1.0,
        include_poly=True,
        include_fourier=False,
        include_tanh=False,
        weight_decay=0.5,
        simplex_weight_decay=1.0,
    )
    learner = d15.GroupwiseBasisLMS(n_heads=2, feature_dim=1, config=config, seed=0)
    state = learner.init()
    state.poly_weights[:] = 1.0

    learner.step(
        state,
        np.asarray([0.0]),
        np.asarray([0.0, 0.0]),
        decay_target=np.asarray([1.0, 0.0]),
    )
    np.testing.assert_allclose(state.poly_weights, 1.0)

    learner.step(state, np.asarray([0.0]), np.asarray([0.0, 0.0]))
    np.testing.assert_allclose(state.poly_weights, 0.5)


def test_d18_persistence_threshold_rejects_chance_label_runs() -> None:
    """Chance-level one-hot persistence does not activate contextual readout."""
    d18 = load_d18_module()
    old_argv = sys.argv
    try:
        sys.argv = ["d18"]
        args = d18.parse_args()
    finally:
        sys.argv = old_argv
    args.configs = "step2_canonical"
    config = d18.make_configs(args)[0]
    learner = d18.SimpleUniversalResourceBasis(
        n_heads=10,
        feature_dim=2,
        config=config,
        seed=0,
    )
    state = learner.init()
    state.simplex_observations = config.simplex_min_observations

    state.target_persistence = 0.2
    assert learner._target_trace_strength(state) == 0.0
    assert not learner._simplex_active(state)

    state.target_persistence = 1.0
    assert learner._target_trace_strength(state) > 0.0
    assert learner._simplex_active(state)


def test_d18_distilled_memory_configs_are_selectable() -> None:
    """Distilled D18 configs should be available for focused ablations."""
    d18 = load_d18_module()
    old_argv = sys.argv
    try:
        sys.argv = ["d18"]
        args = d18.parse_args()
    finally:
        sys.argv = old_argv
    args.configs = "step2_distilled_memory,step2_distilled_memory_nogates"
    configs = d18.make_configs(args)

    assert [config.name for config in configs] == [
        "step2_distilled_memory",
        "step2_distilled_memory_nogates",
    ]
    assert configs[0].prediction_poly_scale == 0.0
    assert configs[0].prototype_scale > 0.0
    assert configs[1].prototype_online
    assert not configs[1].prototype_persistence_gate


def test_d18_prototypes_support_recency_weighted_updates() -> None:
    """Prototype memory can track current head geometry instead of lifetime means."""
    d18 = load_d18_module()
    old_argv = sys.argv
    try:
        sys.argv = ["d18"]
        args = d18.parse_args()
    finally:
        sys.argv = old_argv
    args.configs = "step2_canonical"
    config = replace(d18.make_configs(args)[0], prototype_update_rate=0.25)
    learner = d18.SimpleUniversalResourceBasis(
        n_heads=2,
        feature_dim=1,
        config=config,
        seed=0,
    )
    state = learner.init()

    learner._update_prototypes(
        state,
        np.asarray([0.0]),
        np.asarray([1.0, 0.0]),
    )
    learner._update_prototypes(
        state,
        np.asarray([10.0]),
        np.asarray([1.0, 0.0]),
    )

    np.testing.assert_allclose(state.prototype_counts[0], 2.0)
    np.testing.assert_allclose(state.prototype_means[0], np.asarray([2.5]))


def test_d18_canonical_uses_slim_random_basis_width() -> None:
    """The promoted canonical config keeps the validated smaller tanh basis."""
    d18 = load_d18_module()
    old_argv = sys.argv
    try:
        sys.argv = ["d18"]
        args = d18.parse_args()
    finally:
        sys.argv = old_argv
    args.configs = "step2_canonical"

    config = d18.make_configs(args)[0]

    assert config.basis_config.tanh_width == 128
