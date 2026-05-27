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
                },
                "walk_forward": {
                    "success_rate": 0.5,
                    "failure_rate": 0.0,
                    "episodes": 2,
                    "mean_reward": 8.0,
                    "mean_steps_survived": 20.0,
                    "mean_final_delta_x_m": 0.15,
                    "mean_final_torso_z_m": 0.28,
                    "movement_summary": {
                        "final_delta_x_m": {
                            "min": 0.1,
                            "max": 0.2,
                            "mean": 0.15,
                            "final": 0.2,
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
                    "movement_summary": {"final_torso_z_m": {"final": 0.3}},
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
    assert curriculum["tasks"][0]["movement_summary"]["final_torso_z_m"]["final"] == 0.3
