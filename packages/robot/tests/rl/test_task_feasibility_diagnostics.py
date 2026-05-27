from __future__ import annotations

import pytest

from scripts.validate_task_feasibility import (
    _candidate_score,
    _progress_ratio,
    _success_predicate_diagnostics,
    _termination_reason,
)


def test_success_predicate_diagnostics_marks_unmet_locomotion_predicates() -> None:
    rows = _success_predicate_diagnostics(
        success={
            "torso_z_min_ratio": 0.75,
            "delta_x_m_min": 0.30,
            "max_lateral_drift_m": 0.20,
            "max_abs_delta_yaw_rad": 0.40,
            "window_s": 5.0,
        },
        final_info={
            "torso_z": 0.18,
            "delta_x": 0.12,
            "delta_y": 0.31,
            "delta_yaw": 0.55,
        },
        traces={
            "torso_z": [0.27, 0.21, 0.18],
            "delta_x": [0.02, 0.08, 0.12],
            "delta_y": [0.05, 0.21, 0.31],
            "delta_yaw": [0.10, 0.35, 0.55],
        },
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=1.5,
    )

    by_name = {row["predicate"]: row for row in rows}
    assert by_name["torso_z_min_ratio"]["unmet"] is True
    assert by_name["delta_x_m_min"]["unmet"] is True
    assert by_name["max_lateral_drift_m"]["unmet"] is True
    assert by_name["max_abs_delta_yaw_rad"]["unmet"] is True
    assert by_name["max_lateral_drift_m"]["observed_extreme"] == {
        "max_abs_delta_y_m": 0.31
    }


def test_success_predicate_diagnostics_keeps_met_predicates_clear() -> None:
    rows = _success_predicate_diagnostics(
        success={
            "torso_z_min_ratio": 0.75,
            "delta_yaw_rad_min": 0.7,
            "max_translation_drift_m": 0.25,
            "window_s": 5.0,
        },
        final_info={
            "torso_z": 0.25,
            "delta_x": 0.03,
            "delta_y": 0.04,
            "delta_yaw": 0.85,
        },
        traces={
            "torso_z": [0.23, 0.25],
            "delta_x": [0.01, 0.03],
            "delta_y": [0.02, 0.04],
            "delta_yaw": [0.35, 0.85],
        },
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=2.0,
    )

    assert {row["predicate"]: row["unmet"] for row in rows} == {
        "torso_z_min_ratio": False,
        "delta_yaw_rad_min": False,
        "max_translation_drift_m": False,
    }


def test_termination_reason_prefers_env_info_and_infers_falls() -> None:
    assert (
        _termination_reason(
            {"termination_reason": "explicit_env_reason"},
            terminated=True,
            truncated=False,
        )
        == "explicit_env_reason"
    )
    assert (
        _termination_reason(
            {"torso_z": 0.02, "fall_threshold": 0.05, "upright_proj": 1.0},
            terminated=True,
            truncated=False,
        )
        == "torso_z_below_fall_threshold"
    )
    assert _termination_reason({}, terminated=False, truncated=True) == "episode_step_limit"


def test_success_predicate_diagnostics_reports_no_fall() -> None:
    rows = _success_predicate_diagnostics(
        success={"no_fall": True},
        final_info={"terminated": True},
        traces={"torso_z": [], "delta_x": [], "delta_y": [], "delta_yaw": []},
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=0.5,
    )

    assert rows == [
        {
            "predicate": "no_fall",
            "expected": True,
            "actual": False,
            "unmet": True,
        }
    ]


def test_progress_ratio_uses_best_observed_directional_progress() -> None:
    assert _progress_ratio(
        {"delta_x_m_min": 0.30},
        {
            "torso_z": [],
            "delta_x": [0.05, 0.18, 0.12],
            "delta_y": [],
            "delta_yaw": [],
        },
    ) == pytest.approx(0.6)
    assert _progress_ratio(
        {"delta_yaw_rad_max": -0.7},
        {
            "torso_z": [],
            "delta_x": [],
            "delta_y": [],
            "delta_yaw": [0.1, -0.35, -0.21],
        },
    ) == pytest.approx(0.5)


def test_candidate_score_prefers_success_and_penalizes_falls() -> None:
    success = _candidate_score(
        success=True,
        failed=False,
        terminated=False,
        progress_ratio=0.0,
        unmet_count=0,
    )
    fallen = _candidate_score(
        success=False,
        failed=False,
        terminated=True,
        progress_ratio=1.0,
        unmet_count=2,
    )
    stable = _candidate_score(
        success=False,
        failed=False,
        terminated=False,
        progress_ratio=0.4,
        unmet_count=1,
    )

    assert success > fallen
    assert stable > fallen
