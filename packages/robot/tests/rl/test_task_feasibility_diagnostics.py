from __future__ import annotations

import numpy as np
import pytest

import scripts.validate_task_feasibility as feasibility
from scripts.validate_task_feasibility import (
    _HIWONDER_FORWARD_SINE_PARAMS,
    _candidate_score,
    _make_sinusoidal_action,
    _make_switched_deterministic_action,
    _make_zero_action,
    _primitive_specs,
    _PrimitiveSpec,
    _progress_ratio,
    _rollout,
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
    assert by_name["max_lateral_drift_m"]["observed_extreme"]["max_abs_delta_y_m"] == 0.31
    assert by_name["max_lateral_drift_m"]["observed_extreme"]["source"] == "root"


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


def test_success_predicate_diagnostics_reports_hold_window() -> None:
    rows = _success_predicate_diagnostics(
        success={"hold_s": 1.0},
        final_info={},
        traces={"torso_z": [], "delta_x": [], "delta_y": [], "delta_yaw": []},
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=0.5,
        success_window_s=0.4,
    )

    assert rows == [
        {
            "predicate": "hold_s",
            "expected": {">=": 1.0},
            "actual": 0.4,
            "unmet": True,
        }
    ]


def test_success_predicate_diagnostics_reports_foot_contact_switches() -> None:
    rows = _success_predicate_diagnostics(
        success={"min_alternating_foot_contacts": 2},
        final_info={},
        traces={
            "torso_z": [],
            "delta_x": [],
            "delta_y": [],
            "delta_yaw": [],
            "left_foot_contact": [1.0, 0.0, 1.0],
            "right_foot_contact": [0.0, 1.0, 0.0],
        },
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=0.5,
    )

    assert rows == [
        {
            "predicate": "min_alternating_foot_contacts",
            "expected": {">=": 2},
            "actual": 2,
            "unmet": False,
        }
    ]


def test_success_predicate_diagnostics_prefers_tracked_motion_but_torso_height() -> None:
    rows = _success_predicate_diagnostics(
        success={
            "torso_z_min_ratio": 0.75,
            "torso_z_delta_min_m": 0.04,
            "delta_x_m_min": 0.30,
        },
        final_info={
            "torso_z": 0.10,
            "tracked_z": 0.25,
            "delta_x": 0.50,
            "tracked_delta_x": 0.12,
        },
        traces={
            "torso_z": [0.10],
            "tracked_z": [0.25],
            "delta_x": [0.50],
            "tracked_delta_x": [0.12],
            "delta_y": [],
            "delta_yaw": [],
        },
        start_torso_z_m=0.16,
        stand_height_m=0.27,
        elapsed_s=0.5,
        start_tracked_z_m=0.20,
    )

    by_name = {row["predicate"]: row for row in rows}
    assert by_name["torso_z_min_ratio"]["unmet"] is True
    assert by_name["torso_z_delta_min_m"]["actual"] == pytest.approx(-0.06)
    assert by_name["torso_z_delta_min_m"]["unmet"] is True
    assert by_name["torso_z_min_ratio"]["observed_extreme"]["source"] == "torso"
    assert by_name["delta_x_m_min"]["actual"] == 0.12
    assert by_name["delta_x_m_min"]["unmet"] is True
    assert by_name["delta_x_m_min"]["observed_extreme"] == {
        "source": "tracked_body",
        "max": 0.12,
    }


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


def test_progress_ratio_prefers_tracked_delta_over_root_displacement() -> None:
    assert _progress_ratio(
        {"delta_x_m_min": 0.30},
        {
            "torso_z": [],
            "delta_x": [0.30],
            "tracked_delta_x": [0.03],
            "delta_y": [],
            "delta_yaw": [],
        },
    ) == pytest.approx(0.1)


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


def test_zero_action_factory_returns_stable_shape() -> None:
    class _ActionSpace:
        shape = (3,)

    class _Env:
        action_space = _ActionSpace()

    action_for_step = _make_zero_action(_Env(), "walk_forward")  # type: ignore[arg-type]

    assert action_for_step(0).tolist() == [0.0, 0.0, 0.0]
    assert action_for_step(20).shape == (3,)


def test_hiwonder_locomotion_specs_include_sine_and_settle_primitives() -> None:
    forward = {spec.name for spec in _primitive_specs("hiwonder-ainex", "walk_forward")}
    sidestep = {spec.name for spec in _primitive_specs("hiwonder-ainex", "sidestep_left")}
    stand_up = {spec.name for spec in _primitive_specs("hiwonder-ainex", "stand_up")}

    assert "stand_up_pitch_feedback" in stand_up
    assert "sinusoidal_seeded_0" in forward
    assert "sinusoidal_seeded_1" in forward
    assert "sinusoidal_seeded_3" in forward
    seeded = {
        spec.name: spec
        for spec in _primitive_specs("hiwonder-ainex", "walk_forward")
        if spec.name.startswith("sinusoidal")
    }
    assert seeded["sinusoidal_seeded_3"].params is not None
    assert "switched_deterministic_freeze" in sidestep
    assert "switched_deterministic_damped" in sidestep


def test_hiwonder_stand_up_pitch_feedback_reaches_goal_and_holds() -> None:
    pytest.importorskip("mujoco")

    row = _rollout("hiwonder-ainex", "stand_up", max_steps=260)

    assert row["success"] is True
    assert row["controller"] == "stand_up_pitch_feedback"
    assert row["final_torso_z_m"] >= row["stand_height_m"] * 0.90
    assert row["max_success_window_s"] >= 2.0
    assert row["termination_reason"] is None
    assert row["passive_success"] is False


def test_sit_down_smooth_target_reaches_crouch_and_holds() -> None:
    pytest.importorskip("mujoco")

    row = _rollout("hiwonder-ainex", "sit_down", max_steps=500)

    assert row["success"] is True
    assert row["controller"] == "sit_down_smooth_target"
    assert 0.13 <= row["final_torso_z_m"] <= 0.20
    assert row["max_abs_delta_x_m"] <= 0.10
    assert row["max_abs_delta_y_m"] <= 0.10
    assert row["max_abs_delta_yaw_rad"] <= 0.35
    assert row["max_success_window_s"] >= 1.0
    assert row["termination_reason"] is None
    assert row["passive_success"] is False


def test_rollout_reports_imu_tilt_extrema() -> None:
    pytest.importorskip("mujoco")

    row = _rollout("hiwonder-ainex", "sidestep_left", max_steps=80)

    assert row["max_abs_imu_roll_rad"] is not None
    assert row["max_abs_imu_pitch_rad"] is not None
    assert row["diagnostics"]["imu_roll_rad"]["max_abs"] == row["max_abs_imu_roll_rad"]
    assert row["diagnostics"]["imu_pitch_rad"]["max_abs"] == row["max_abs_imu_pitch_rad"]
    assert row["candidate_results"][0]["max_abs_imu_roll_rad"] is not None
    assert row["candidate_results"][0]["max_abs_imu_pitch_rad"] is not None


def test_sinusoidal_action_freezes_after_hold_switch() -> None:
    class _Joint:
        def __init__(self, name: str) -> None:
            self.name = name

    class _ActionSpace:
        shape = (3,)

    class _Env:
        action_space = _ActionSpace()
        config = type("_Config", (), {"control_dt_s": 0.02})()
        _action_joints = [_Joint("l_hip_pitch"), _Joint("r_knee"), _Joint("l_ank_roll")]

    params = dict(_HIWONDER_FORWARD_SINE_PARAMS[0])
    params.update({"hold_switch_step": 2, "hold_mode": "freeze"})
    action_for_step = _make_sinusoidal_action(_Env(), "walk_forward", params=params)  # type: ignore[arg-type]

    pre_hold = action_for_step(1)
    first_hold = action_for_step(2)
    second_hold = action_for_step(3)

    assert pre_hold is not None
    assert first_hold is not None
    assert second_hold is not None
    assert first_hold.tolist() == pytest.approx(pre_hold.tolist())
    assert second_hold.tolist() == pytest.approx(first_hold.tolist())


def test_switched_deterministic_action_can_freeze_last_active_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _ActionSpace:
        shape = (2,)

    class _Env:
        action_space = _ActionSpace()

    def _fake_action(_env: object, _task_id: str, step: int):
        return np.array([float(step), -float(step)], dtype=np.float32)

    monkeypatch.setattr(feasibility, "_deterministic_action", _fake_action)
    action_for_step = _make_switched_deterministic_action(  # type: ignore[arg-type]
        _Env(),
        "sidestep_left",
        switch_step=2,
        hold_mode="freeze",
    )

    assert action_for_step(0).tolist() == [0.0, 0.0]
    assert action_for_step(1).tolist() == [1.0, -1.0]
    assert action_for_step(2).tolist() == [1.0, -1.0]


def test_rollout_reports_passive_baseline() -> None:
    pytest.importorskip("mujoco")

    row = _rollout("hiwonder-ainex", "walk_forward", max_steps=3)

    passive = row["passive_baseline"]
    assert passive["controller"] == "zero_action_baseline"
    assert passive["steps"] >= 1
    assert "passive_baseline" in row["diagnostics"]
    assert row["passive_success"] is False
    assert row["valid_success"] is row["active_success"]


def test_rollout_rejects_success_when_passive_baseline_also_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    primitive = _PrimitiveSpec("active", 0.3, lambda _env, _task: lambda _step: None)

    def _fake_specs(_profile_id: str, _task_id: str) -> list[_PrimitiveSpec]:
        return [primitive]

    def _fake_candidate(
        _profile: str,
        _task_id: str,
        *,
        max_steps: int,
        primitive: _PrimitiveSpec,
    ) -> dict:
        return {
            "task_id": "walk_forward",
            "controller": primitive.name,
            "action_scale": primitive.action_scale,
            "success": True,
            "failed": False,
            "reason": "",
            "steps": max_steps,
            "terminated": False,
            "truncated": True,
            "termination_reason": "time_limit",
            "final_torso_z_m": 0.25,
            "final_tracked_z_m": 0.25,
            "final_delta_x_m": 0.31,
            "final_delta_y_m": 0.0,
            "final_delta_yaw_rad": 0.0,
            "progress_ratio": 1.0,
            "candidate_score": 101.0,
            "diagnostics": {
                "unmet_success_predicates": [],
                "progress_ratio": 1.0,
                "tracked_body": {"height_present": True},
            },
        }

    monkeypatch.setattr(feasibility, "_primitive_specs", _fake_specs)
    monkeypatch.setattr(feasibility, "_rollout_candidate", _fake_candidate)

    row = _rollout("unitree-r1", "walk_forward", max_steps=12)

    assert row["active_success"] is True
    assert row["passive_success"] is True
    assert row["valid_success"] is False
    assert row["success"] is False
    assert row["invalid_reasons"] == ["passive_baseline_also_succeeds"]


def test_rollout_rejects_root_only_locomotion_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    primitive = _PrimitiveSpec("root_only", 0.3, lambda _env, _task: lambda _step: None)

    def _fake_specs(_profile_id: str, _task_id: str) -> list[_PrimitiveSpec]:
        return [primitive]

    def _fake_candidate(
        _profile: str,
        _task_id: str,
        *,
        max_steps: int,
        primitive: _PrimitiveSpec,
    ) -> dict:
        del _profile, _task_id, max_steps
        return {
            "task_id": "walk_forward",
            "controller": primitive.name,
            "action_scale": primitive.action_scale,
            "success": primitive.name == "root_only",
            "failed": False,
            "reason": "",
            "steps": 12,
            "terminated": False,
            "truncated": True,
            "termination_reason": "time_limit",
            "final_torso_z_m": 0.25,
            "final_delta_x_m": 0.31,
            "final_delta_y_m": 0.0,
            "final_delta_yaw_rad": 0.0,
            "progress_ratio": 1.0,
            "candidate_score": 101.0 if primitive.name == "root_only" else 0.0,
            "diagnostics": {
                "unmet_success_predicates": [],
                "progress_ratio": 1.0,
                "tracked_body": {"height_present": False},
            },
        }

    monkeypatch.setattr(feasibility, "_primitive_specs", _fake_specs)
    monkeypatch.setattr(feasibility, "_rollout_candidate", _fake_candidate)

    row = _rollout("unitree-r1", "walk_forward", max_steps=12)

    assert row["active_success"] is True
    assert row["success"] is False
    assert row["invalid_reasons"] == ["tracked_height_missing_for_locomotion"]


def test_rollout_rejects_falling_locomotion_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    primitive = _PrimitiveSpec("falling", 0.3, lambda _env, _task: lambda _step: None)

    def _fake_specs(_profile_id: str, _task_id: str) -> list[_PrimitiveSpec]:
        return [primitive]

    def _fake_candidate(
        _profile: str,
        _task_id: str,
        *,
        max_steps: int,
        primitive: _PrimitiveSpec,
    ) -> dict:
        del _profile, _task_id, max_steps
        is_active = primitive.name == "falling"
        return {
            "task_id": "walk_forward",
            "controller": primitive.name,
            "action_scale": primitive.action_scale,
            "success": is_active,
            "failed": False,
            "reason": "",
            "steps": 12,
            "terminated": is_active,
            "truncated": not is_active,
            "termination_reason": "fall" if is_active else "time_limit",
            "final_torso_z_m": 0.04 if is_active else 0.25,
            "final_tracked_z_m": 0.04 if is_active else 0.25,
            "final_delta_x_m": 0.31 if is_active else 0.0,
            "final_delta_y_m": 0.0,
            "final_delta_yaw_rad": 0.0,
            "progress_ratio": 1.0 if is_active else 0.0,
            "candidate_score": 101.0 if is_active else 0.0,
            "diagnostics": {
                "unmet_success_predicates": [],
                "progress_ratio": 1.0 if is_active else 0.0,
                "tracked_body": {"height_present": True},
            },
        }

    monkeypatch.setattr(feasibility, "_primitive_specs", _fake_specs)
    monkeypatch.setattr(feasibility, "_rollout_candidate", _fake_candidate)

    row = _rollout("unitree-r1", "walk_forward", max_steps=12)

    assert row["active_success"] is True
    assert row["success"] is False
    assert row["invalid_reasons"] == ["active_candidate_fell"]


def test_hiwonder_turn_primitives_can_hold_signed_yaw_without_fall() -> None:
    pytest.importorskip("mujoco")

    left = _rollout("hiwonder-ainex", "turn_left", max_steps=500)
    right = _rollout("hiwonder-ainex", "turn_right", max_steps=500)

    assert left["success"] is True
    assert left["controller"] == "deterministic_wide"
    assert left["final_delta_yaw_rad"] >= 0.7
    assert left["termination_reason"] is None
    assert left["passive_success"] is False

    assert right["success"] is True
    assert right["controller"] == "deterministic_wide"
    assert right["final_delta_yaw_rad"] <= -0.7
    assert right["termination_reason"] is None
    assert right["passive_success"] is False
