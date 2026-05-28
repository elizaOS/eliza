from __future__ import annotations

import json
from pathlib import Path

from scripts import eval_text_policy
from scripts.eval_text_policy import curriculum_report_from_eval


class _GoalResult:
    def __init__(self, *, success: bool = False, failed: bool = False, reason: str = ""):
        self.success = success
        self.failed = failed
        self.reason = reason


def test_env_termination_counts_as_eval_failure() -> None:
    result = _GoalResult(success=False, failed=False)

    assert (
        eval_text_policy._rollout_failed(  # noqa: SLF001
            result,
            terminated=True,
            success=False,
        )
        is True
    )
    assert (
        eval_text_policy._rollout_reason(  # noqa: SLF001
            result,
            terminated=True,
            success=False,
        )
        == "env_terminated_before_goal_success"
    )


def test_successful_terminal_rollout_does_not_count_as_failure() -> None:
    result = _GoalResult(success=True, failed=False, reason="goal reached")

    assert (
        eval_text_policy._rollout_failed(  # noqa: SLF001
            result,
            terminated=True,
            success=True,
        )
        is False
    )
    assert (
        eval_text_policy._rollout_reason(  # noqa: SLF001
            result,
            terminated=True,
            success=True,
        )
        == "goal reached"
    )


def test_eval_goal_sample_uses_tracked_motion_torso_height_and_carries_contacts() -> None:
    sample = eval_text_policy._telemetry_sample_from_info(  # noqa: SLF001
        1.25,
        {
            "root_x": 0.0,
            "root_y": 0.0,
            "torso_z": 0.2,
            "tracked_x": 0.31,
            "tracked_y": 0.02,
            "tracked_z": 0.27,
            "root_yaw": 0.1,
            "imu_roll": 0.01,
            "imu_pitch": 0.02,
            "left_foot_contact": True,
            "right_foot_contact": False,
            "stand_height_m": 0.25,
        },
    )

    assert sample.torso_x_m == 0.0
    assert sample.torso_y_m == 0.0
    assert sample.torso_z_m == 0.2
    assert sample.extra["left_foot_contact"] is True
    assert sample.extra["right_foot_contact"] is False
    assert sample.extra["root_x_m"] == 0.0
    assert sample.extra["tracked_x_m"] == 0.31
    assert sample.extra["tracked_y_m"] == 0.02
    assert sample.extra["tracked_z_m"] == 0.27


def test_curriculum_report_from_eval_requires_full_task_success() -> None:
    report = curriculum_report_from_eval(
        {
            "profile_id": "hiwonder-ainex",
            "env": "profile_mujoco",
            "checkpoint": "checkpoints/hiwonder_ainex_alberta_full",
            "policy": "alberta_streaming",
            "mean_success_rate_overall": 0.5,
            "tasks": {
                "stand_up": {
                    "success_rate": 1.0,
                    "failure_rate": 0.0,
                    "episodes": 2,
                    "mean_reward": 10.0,
                    "mean_steps_survived": 20.0,
                    "mean_final_torso_z_m": 0.28,
                    "mean_final_torso_z_delta_m": 0.03,
                    "mean_final_tracked_z_m": 0.28,
                    "mean_final_tracked_delta_z_m": 0.03,
                },
                "walk_forward": {
                    "success_rate": 1.0,
                    "failure_rate": 0.0,
                    "episodes": 2,
                    "mean_reward": 8.0,
                    "mean_steps_survived": 20.0,
                    "mean_final_delta_x_m": 0.15,
                    "mean_final_delta_y_m": 0.01,
                    "mean_final_delta_yaw_rad": 0.01,
                    "mean_final_torso_z_m": 0.28,
                    "mean_final_tracked_delta_x_m": 0.15,
                    "mean_final_tracked_delta_y_m": 0.01,
                    "mean_final_tracked_z_m": 0.28,
                    "movement_summary": {
                        "final_delta_x_m": {
                            "min": 0.1,
                            "max": 0.2,
                            "mean": 0.15,
                            "final": 0.2,
                        },
                        "final_tracked_delta_x_m": {
                            "min": 0.1,
                            "max": 0.2,
                            "mean": 0.15,
                            "final": 0.2,
                        },
                        "final_tracked_delta_y_m": {
                            "min": 0.01,
                            "max": 0.02,
                            "mean": 0.015,
                            "final": 0.02,
                        },
                        "max_abs_lateral_drift_m": {
                            "min": 0.01,
                            "max": 0.02,
                            "mean": 0.015,
                            "final": 0.02,
                        },
                    },
                },
            },
        }
    )

    assert report["schema"] == "robot-policy-curriculum-eval-v1"
    assert report["checkpoint"] == "checkpoints/hiwonder_ainex_alberta_full"
    assert report["n_tasks"] == 2
    assert report["n_programmatic_pass"] == 1
    assert report["programmatic_pass_rate"] == 0.5
    rows = {row["task_id"]: row for row in report["tasks"]}
    assert rows["stand_up"]["success_programmatic"] is True
    assert rows["walk_forward"]["success_programmatic"] is False
    assert rows["walk_forward"]["physical_success"] is False
    assert rows["walk_forward"]["physical_checks"]["tracked_delta_x_forward"] is False
    assert rows["walk_forward"]["movement_summary"]["final_delta_x_m"]["max"] == 0.2


def test_eval_cli_requires_both_exact_curriculum_output_paths(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    try:
        eval_text_policy.main(
            [
                "--profile",
                "hiwonder-ainex",
                "--untrained",
                "--tasks",
                "stand_up",
                "--curriculum-report-out",
                "evidence/curriculum_eval/report.json",
                "--fail-under-success-rate",
                "1.0",
            ]
        )
    except ValueError as exc:
        assert "--out evidence/curriculum_eval/eval_text_policy.json" in str(exc)
    else:
        raise AssertionError("expected missing native eval output path to fail")


def test_eval_cli_writes_native_and_curriculum_outputs(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)

    def fake_evaluate(*_args, **_kwargs):
        return {
            "schema": "robot-text-policy-eval-v1",
            "profile_id": "hiwonder-ainex",
            "env": "profile_mujoco",
            "checkpoint": "checkpoint",
            "policy": "untrained_zero",
            "tasks": {
                "stand_up": {
                    "success_rate": 1.0,
                    "failure_rate": 0.0,
                    "episodes": 1,
                    "mean_reward": 1.0,
                    "mean_steps_survived": 1.0,
                    "mean_final_torso_z_m": 0.3,
                    "mean_final_torso_z_delta_m": 0.03,
                    "mean_final_tracked_z_m": 0.3,
                    "mean_final_tracked_delta_z_m": 0.03,
                    "movement_summary": {
                        "final_torso_z_m": {"final": 0.3},
                        "final_tracked_z_m": {"min": 0.3, "final": 0.3},
                        "final_tracked_delta_z_m": {"min": 0.03, "final": 0.03},
                    },
                }
            },
            "mean_success_rate_overall": 1.0,
        }

    monkeypatch.setattr(eval_text_policy, "evaluate", fake_evaluate)

    rc = eval_text_policy.main(
        [
            "--profile",
            "hiwonder-ainex",
            "--untrained",
            "--tasks",
            "stand_up",
            "--out",
            "evidence/curriculum_eval/eval_text_policy.json",
            "--curriculum-report-out",
            "evidence/curriculum_eval/report.json",
            "--fail-under-success-rate",
            "1.0",
        ]
    )

    assert rc == 0
    native = json.loads(
        (tmp_path / "evidence/curriculum_eval/eval_text_policy.json").read_text()
    )
    curriculum = json.loads(
        (tmp_path / "evidence/curriculum_eval/report.json").read_text()
    )
    assert native["schema"] == "robot-text-policy-eval-v1"
    assert curriculum["schema"] == "robot-policy-curriculum-eval-v1"
    assert curriculum["tasks"][0]["physical_success"] is True
    assert curriculum["tasks"][0]["movement_summary"]["final_torso_z_m"]["final"] == 0.3


def test_task_physical_checks_require_expected_direction() -> None:
    checks = eval_text_policy.task_physical_checks(
        "walk_forward",
        {
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 1,
            "mean_final_delta_x_m": -0.4,
            "mean_final_delta_y_m": 0.0,
            "mean_final_delta_yaw_rad": 0.0,
            "mean_final_tracked_delta_x_m": -0.4,
            "mean_final_tracked_delta_y_m": 0.0,
            "mean_final_tracked_z_m": 0.3,
        },
    )

    assert checks["success_rate_full"] is True
    assert checks["tracked_delta_x_forward"] is False


def test_task_physical_checks_require_per_episode_forward_progress() -> None:
    checks = eval_text_policy.task_physical_checks(
        "walk_forward",
        {
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 2,
            "mean_final_delta_x_m": 0.35,
            "mean_final_delta_y_m": 0.0,
            "mean_final_delta_yaw_rad": 0.0,
            "mean_final_tracked_delta_x_m": 0.35,
            "mean_final_tracked_delta_y_m": 0.0,
            "mean_final_tracked_z_m": 0.3,
            "movement_summary": {
                "final_delta_x_m": {
                    "min": -0.1,
                    "max": 0.8,
                    "mean": 0.35,
                    "final": 0.8,
                },
                "final_tracked_delta_x_m": {
                    "min": -0.1,
                    "max": 0.8,
                    "mean": 0.35,
                    "final": 0.8,
                },
                "final_tracked_delta_y_m": {
                    "min": 0.0,
                    "max": 0.0,
                    "mean": 0.0,
                    "final": 0.0,
                },
                "max_abs_lateral_drift_m": {
                    "min": 0.0,
                    "max": 0.01,
                    "mean": 0.005,
                    "final": 0.01,
                },
                "final_delta_yaw_rad": {
                    "min": 0.0,
                    "max": 0.01,
                    "mean": 0.005,
                    "final": 0.01,
                },
            },
        },
    )

    assert checks["tracked_delta_x_forward"] is False


def test_task_physical_checks_require_stand_up_height_gain() -> None:
    checks = eval_text_policy.task_physical_checks(
        "stand_up",
        {
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 1,
            "mean_final_torso_z_m": 0.3,
            "mean_final_torso_z_delta_m": 0.0,
            "mean_final_tracked_z_m": 0.3,
            "mean_final_tracked_delta_z_m": 0.0,
        },
    )

    assert checks["torso_height_finite_positive"] is True
    assert checks["torso_height_gain"] is False
    assert checks["tracked_height_finite_positive"] is True
    assert checks["tracked_height_gain"] is False


def test_task_physical_checks_require_turn_drift_bound() -> None:
    checks = eval_text_policy.task_physical_checks(
        "turn_left",
        {
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 1,
            "mean_final_delta_x_m": 0.4,
            "mean_final_delta_y_m": 0.0,
            "mean_final_delta_yaw_rad": 0.8,
            "mean_final_tracked_delta_x_m": 0.4,
            "mean_final_tracked_delta_y_m": 0.0,
            "mean_final_tracked_z_m": 0.3,
            "movement_summary": {
                "final_delta_yaw_rad": {
                    "min": 0.8,
                    "max": 0.8,
                    "mean": 0.8,
                    "final": 0.8,
                },
                "final_translation_drift_m": {
                    "min": 0.4,
                    "max": 0.4,
                    "mean": 0.4,
                    "final": 0.4,
                },
            },
        },
    )

    assert checks["delta_yaw_left"] is True
    assert checks["tracked_translation_drift_bound"] is False
