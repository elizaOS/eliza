from __future__ import annotations

import json

import scripts.search_hiwonder_random_sine_gaits as random_sine_search
from scripts.search_hiwonder_open_loop_gaits import _candidate_specs, _failure_frontier
from scripts.search_hiwonder_random_sine_gaits import (
    _candidate_params,
    _feedback_refinement_params,
    _hybrid_recovery_refinement_params,
    _local_refinement_params,
    _max_self_collision_observed,
    _refine_best_straight,
    _stable_bridge_refinement_params,
    _top_by,
    _transition_refinement_params,
)
from scripts.search_hiwonder_stabilized_gaits import (
    _candidate_specs as _stabilized_candidate_specs,
)
from scripts.sweep_hiwonder_near_gait_hold import (
    _candidate_entries_from_search_report,
    _raw_distance_key,
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

    assert len(params) == 1004
    assert "feedback" in params[0]
    assert any("feedback" not in row for row in params)
    assert params[0]["hybrid_recovery"] == {
        "switch_step": 24,
        "ramp_steps": 1,
        "pitch_gain": 0.5,
        "roll_gain": -0.5,
        "pre_scale": 1.0,
        "post_bias": 0.0,
    }
    assert any(row["hybrid_recovery"]["pitch_gain"] == 8.0 for row in params)
    assert any(row["hybrid_recovery"]["roll_gain"] == 2.0 for row in params)
    assert any("knee_bias" in row["hybrid_recovery"] for row in params)
    assert any("switch_dx" in row["hybrid_recovery"] for row in params)
    assert any(row["scale"] == 0.8465768408918739 for row in params)
    assert any(row["hybrid_recovery"]["switch_step"] == 32 for row in params)


def test_hiwonder_random_sine_stable_bridge_refinement_ablation_is_bounded() -> None:
    base = {
        **_candidate_params(seed=123, n_candidates=1)[0],
        "feedback": {"pitch": 1.0},
        "hybrid_recovery": {"switch_step": 24},
    }
    params = _stable_bridge_refinement_params(base)

    assert len(params) == 168
    assert params[0]["feedback"] == {"pitch": 1.0}
    assert params[0]["hybrid_recovery"] == {"switch_step": 24}
    assert params[-1]["scale"] == base["scale"] * 2.5
    assert params[-1]["hip_bias"] == base["hip_bias"] + 0.35
    assert "feedback" not in params[-1]
    assert "hybrid_recovery" not in params[-1]


def test_hiwonder_random_sine_collision_observer_uses_episode_max() -> None:
    observed = _max_self_collision_observed(
        current_counts=[0.0, 3.0, 0.0],
        max_counts=[0.0, 1.0, 2.0],
        final_info={"self_collision_count": 0, "max_self_collision_count": 1},
    )

    assert observed == 3.0


def test_hiwonder_random_sine_refinement_propagates_goal_failure_continuation(
    monkeypatch,
) -> None:
    calls = []

    def fake_run_candidates(*_args, **kwargs):
        calls.append(kwargs)
        return []

    monkeypatch.setattr(random_sine_search, "_run_candidates", fake_run_candidates)

    report = _refine_best_straight(
        object(),  # type: ignore[arg-type]
        broad_frontier={
            "best_forward_straight": {
                "controller": "near",
                "controller_params": _candidate_params(seed=1, n_candidates=1)[0],
            }
        },
        seed=2,
        n_candidates=1,
        max_steps=3,
        continue_after_goal_failure=True,
    )

    assert report["base_controller"] == "near"
    assert calls
    assert calls[0]["continue_after_goal_failure"] is True


def test_hiwonder_hold_sweep_top_k_selects_ranked_candidate_list(tmp_path) -> None:
    report = {
        "feedback_refinement": {
            "best_by_success_window": {
                "controller": "best_by_success_window",
                "controller_params": {"scale": 0.5},
            },
            "candidates": [
                {
                    "controller": "far_unstable",
                    "controller_params": {"scale": 0.8},
                    "final_delta_x_m": 0.28,
                    "max_success_window_s": 0.0,
                    "max_abs_delta_yaw_rad": 0.8,
                    "diagnostics": {
                        "unmet_success_predicates": [
                            "max_abs_delta_yaw_rad",
                            "no_fall",
                            "hold_s",
                        ]
                    },
                },
                {
                    "controller": "clean_short",
                    "controller_params": {"scale": 0.4},
                    "final_delta_x_m": 0.18,
                    "max_success_window_s": 0.0,
                    "max_abs_delta_yaw_rad": 0.2,
                    "diagnostics": {"unmet_success_predicates": ["delta_x_m_min"]},
                },
            ]
        }
    }
    path = tmp_path / "search.json"
    path.write_text(json.dumps(report), encoding="utf-8")

    entries = _candidate_entries_from_search_report(
        path,
        section="feedback_refinement",
        selector="best_by_success_window",
        top_k=1,
    )
    top_entries = _candidate_entries_from_search_report(
        path,
        section="feedback_refinement",
        selector="best_by_success_window",
        top_k=2,
        rank="physical-gates",
    )

    assert entries[0][0] == "best_by_success_window"
    assert top_entries[0] == ("clean_short", {"scale": 0.4})
    assert top_entries[1] == ("far_unstable", {"scale": 0.8})


def test_hiwonder_random_sine_top_by_preserves_ranked_prefix() -> None:
    rows = [{"score": 1}, {"score": 3}, {"score": 2}]

    top = _top_by(rows, key=lambda row: row["score"], limit=2)

    assert top == [{"score": 3}, {"score": 2}]


def test_hiwonder_hold_sweep_raw_distance_key_uses_post_failure_frontier() -> None:
    row = {
        "final_delta_x_m": 0.10,
        "max_delta_x_m": 0.12,
        "post_goal_failure_max_delta_x_m": 0.21,
        "max_abs_delta_yaw_rad": 0.30,
        "max_foot_slip_m_s": 0.20,
        "max_self_collision_count": 0,
    }

    assert _raw_distance_key(row)[0] == 0.21


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
