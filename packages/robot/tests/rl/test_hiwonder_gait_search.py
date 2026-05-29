from __future__ import annotations

from scripts.search_hiwonder_open_loop_gaits import _candidate_specs, _failure_frontier
from scripts.search_hiwonder_random_sine_gaits import (
    _candidate_params,
    _feedback_refinement_params,
    _hybrid_recovery_refinement_params,
    _local_refinement_params,
    _transition_refinement_params,
)
from scripts.search_hiwonder_stabilized_gaits import (
    _candidate_specs as _stabilized_candidate_specs,
)


def test_hiwonder_gait_search_includes_seeded_sinusoidal_probes() -> None:
    names = {spec.name for spec in _candidate_specs()}

    assert "sinusoidal_seeded_0" in names
    assert "sinusoidal_seeded_1" in names
    assert "sinusoidal_seeded_2" in names
    assert "sinusoidal_seeded_3" in names
    assert "sinusoidal_seeded_4" in names
    assert "sinusoidal_seeded_5" in names
    seeded = {spec.name: spec for spec in _candidate_specs() if spec.name.startswith("sinusoidal")}
    assert seeded["sinusoidal_seeded_4"].params is not None
    assert seeded["sinusoidal_seeded_5"].params is not None


def test_hiwonder_random_sine_search_candidates_are_reproducible() -> None:
    first = _candidate_params(seed=123, n_candidates=3)
    second = _candidate_params(seed=123, n_candidates=3)

    assert first == second
    assert len(first) == 3
    assert all("scale" in params and "hz" in params for params in first)


def test_hiwonder_random_sine_local_refinement_is_reproducible() -> None:
    base = _candidate_params(seed=123, n_candidates=1)[0]
    first = _local_refinement_params(base, seed=456, n_candidates=3)
    second = _local_refinement_params(base, seed=456, n_candidates=3)

    assert first == second
    assert len(first) == 3
    assert all(params["yaw_amp"] == 0.0 for params in first)


def test_hiwonder_random_sine_transition_refinement_is_deterministic() -> None:
    base = _candidate_params(seed=123, n_candidates=1)[0]
    params = _transition_refinement_params(
        base,
        switch_steps=(260, 261),
        hold_modes=("freeze", "zero"),
        blend_steps=(0, 4),
    )

    assert len(params) == 8
    assert params[0]["hold_switch_step"] == 260.0
    assert params[0]["hold_mode"] == "freeze"
    assert params[0]["hold_blend_steps"] == 0.0
    assert params[-1]["hold_switch_step"] == 261.0
    assert params[-1]["hold_mode"] == "zero"
    assert params[-1]["hold_blend_steps"] == 4.0


def test_hiwonder_random_sine_feedback_refinement_is_deterministic() -> None:
    base = _candidate_params(seed=123, n_candidates=1)[0]
    first = _feedback_refinement_params(base)
    second = _feedback_refinement_params(base)

    assert first == second
    assert len(first) > 100
    assert first[0]["feedback"] == {
        "pitch": -1.0,
        "roll": -1.0,
        "yaw": -0.5,
    }
    assert "damp_after" in first[-1]["feedback"]


def test_hiwonder_random_sine_hybrid_recovery_refinement_is_bounded() -> None:
    base = _candidate_params(seed=123, n_candidates=1)[0]
    params = _hybrid_recovery_refinement_params({**base, "feedback": {"pitch": 1.0}})

    assert len(params) == 80
    assert "feedback" not in params[0]
    assert params[0]["hybrid_recovery"] == {
        "switch_step": 24,
        "ramp_steps": 1,
        "pitch_gain": 0.5,
        "pre_scale": 1.0,
        "post_bias": 0.0,
    }
    assert params[-1]["hybrid_recovery"]["switch_step"] == 32


def test_hiwonder_stabilized_gait_search_includes_hold_strategies() -> None:
    names = {spec.name for spec in _stabilized_candidate_specs()}
    assert "sine_freeze_s224_b0" in names
    assert "sine_zero_s224_b8" in names
    assert "snapshot_hold_s230_b8" in names
    freeze = next(spec for spec in _stabilized_candidate_specs() if spec.name == "sine_freeze_s224_b0")
    assert freeze.params is not None


def test_hiwonder_gait_failure_frontier_identifies_primary_gap() -> None:
    rows = [
        {
            "controller": "stable_shuffle",
            "failed": False,
            "terminated": False,
            "final_delta_x_m": 0.10,
            "max_delta_x_m": 0.12,
            "max_abs_delta_y_m": 0.02,
            "max_abs_delta_yaw_rad": 0.05,
            "diagnostics": {"unmet_success_predicates": ["delta_x_m_min"]},
        },
        {
            "controller": "falling_lunge",
            "failed": True,
            "terminated": True,
            "final_delta_x_m": 0.32,
            "max_delta_x_m": 0.32,
            "max_abs_delta_y_m": 0.04,
            "max_abs_delta_yaw_rad": 0.10,
            "diagnostics": {"unmet_success_predicates": ["no_fall", "hold_s"]},
        },
    ]

    frontier = _failure_frontier(rows)

    assert frontier["primary_gap"] == "stability"
    assert frontier["n_forward_displacement_candidates"] == 1
    assert frontier["n_forward_no_fall_candidates"] == 0
    assert frontier["best_forward_without_fall"]["controller"] == "stable_shuffle"
