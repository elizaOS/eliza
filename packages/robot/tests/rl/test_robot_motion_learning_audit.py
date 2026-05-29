from __future__ import annotations

import json
from pathlib import Path

from scripts.audit_robot_motion_learning import (
    DEFAULT_TASK_FEASIBILITY_PATH,
    _fresh_obstacle_smoke_summary,
    _learned_policy_curriculum_eval_summary,
    _local_learning_probe_from_dir,
    _local_learning_probe_summary,
    _multi_profile_walk_summary,
    _near_gait_visual_summary,
    _task_feasibility_summary,
)


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _curriculum_physical_checks(task_id: str) -> dict[str, bool]:
    if task_id == "stand_up":
        return {
            "episodes": True,
            "success_rate_full": True,
            "failure_rate_zero": True,
            "hold_s": True,
            "torso_height_gain": True,
            "tracked_height_gain": True,
            "torso_height_finite_positive": True,
            "tracked_height_finite_positive": True,
        }
    if task_id == "walk_forward":
        return {
            "episodes": True,
            "success_rate_full": True,
            "failure_rate_zero": True,
            "no_fall": True,
            "hold_s": True,
            "min_alternating_foot_contacts": True,
            "min_swing_foot_clearance_m": True,
            "max_foot_slip_m_s": True,
            "max_self_collision_count": True,
            "tracked_height_present": True,
            "tracked_delta_x_forward": True,
            "tracked_lateral_drift_bound": True,
            "yaw_drift_bound": True,
        }
    raise AssertionError(f"unsupported test task: {task_id}")


def _motion_fields(task_id: str, *, tracked_body_name: str = "pelvis_link") -> dict[str, float | str]:
    fields: dict[str, float | str] = {
        "tracked_body_name": tracked_body_name,
        "mean_final_delta_x_m": 0.0,
        "mean_final_delta_y_m": 0.0,
        "mean_final_delta_yaw_rad": 0.0,
        "mean_final_tracked_delta_x_m": 0.0,
        "mean_final_tracked_delta_y_m": 0.0,
        "mean_final_tracked_delta_z_m": 0.0,
        "mean_final_tracked_z_m": 0.4,
        "mean_final_torso_z_m": 0.4,
        "mean_final_torso_z_delta_m": 0.0,
    }
    if task_id == "stand_up":
        fields["mean_final_tracked_delta_z_m"] = 0.08
        fields["mean_final_torso_z_delta_m"] = 0.08
    elif task_id == "walk_forward":
        fields["mean_final_delta_x_m"] = 0.35
        fields["mean_final_tracked_delta_x_m"] = 0.35
    return fields


def _write_learned_policy_eval(
    run_root: Path,
    *,
    curriculum_task_overrides: dict[str, dict] | None = None,
    native_task_overrides: dict[str, dict] | None = None,
) -> None:
    checkpoint = run_root / "checkpoint"
    checkpoint.mkdir(parents=True)
    tasks = ("stand_up", "walk_forward")
    curriculum_rows = []
    native_tasks = {}
    for task_id in tasks:
        row = {
            "task_id": task_id,
            "success_programmatic": True,
            "physical_success": True,
            "physical_checks": _curriculum_physical_checks(task_id),
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 2,
            "error": None,
            **_motion_fields(task_id),
        }
        row.update((curriculum_task_overrides or {}).get(task_id, {}))
        curriculum_rows.append(row)
        native = {
            "success_rate": 1.0,
            "failure_rate": 0.0,
            "episodes": 2,
            **_motion_fields(task_id),
        }
        native.update((native_task_overrides or {}).get(task_id, {}))
        native_tasks[task_id] = native
    _write_json(
        run_root / "evidence" / "curriculum_eval" / "report.json",
        {
            "schema": "robot-policy-curriculum-eval-v1",
            "source": "eval_text_policy",
            "profile_id": "asimov-1",
            "policy": "checkpoint:checkpoint",
            "checkpoint": str(checkpoint),
            "n_tasks": len(tasks),
            "n_programmatic_pass": len(tasks),
            "programmatic_pass_rate": 1.0,
            "mean_success_rate_overall": 1.0,
            "tasks": curriculum_rows,
        },
    )
    _write_json(
        run_root / "evidence" / "curriculum_eval" / "eval_text_policy.json",
        {
            "schema": "robot-text-policy-eval-v1",
            "profile_id": "asimov-1",
            "checkpoint": str(checkpoint),
            "tasks": native_tasks,
        },
    )


def test_robot_motion_audit_defaults_to_current_all_task_feasibility() -> None:
    assert DEFAULT_TASK_FEASIBILITY_PATH.name == "hiwonder_ainex_current.json"
    assert DEFAULT_TASK_FEASIBILITY_PATH.parent.name == "task_feasibility"


def test_task_feasibility_summary_surfaces_best_failed_candidate() -> None:
    summary = _task_feasibility_summary(
        {
            "profile_id": "hiwonder-ainex",
            "all_success": False,
            "n_tasks": 1,
            "n_success": 0,
            "tasks": [
                {
                    "task_id": "walk_forward",
                    "success": False,
                    "controller": "deterministic_smoke",
                    "termination_reason": "time_limit",
                    "final_delta_x_m": -0.01,
                    "progress_ratio": 0.10,
                    "diagnostics": {
                        "unmet_success_predicates": ["delta_x_m_min"],
                    },
                    "candidate_results": [
                        {
                            "controller": "falls_forward",
                            "success": False,
                            "failed": True,
                            "termination_reason": "fall",
                            "final_delta_x_m": 0.08,
                            "final_delta_y_m": 0.0,
                            "progress_ratio": 0.25,
                            "max_success_window_s": 0.0,
                            "candidate_score": -2.0,
                            "unmet_success_predicates": [
                                "delta_x_m_min",
                                "no_fall",
                            ],
                        },
                        {
                            "controller": "stable_backward",
                            "success": False,
                            "failed": False,
                            "termination_reason": "time_limit",
                            "final_delta_x_m": -0.01,
                            "final_delta_y_m": 0.0,
                            "progress_ratio": 0.10,
                            "max_success_window_s": 0.0,
                            "candidate_score": -0.2,
                            "unmet_success_predicates": ["delta_x_m_min"],
                        },
                    ],
                    "passive_baseline": {
                        "controller": "zero_action_baseline",
                        "success": False,
                        "failed": False,
                        "termination_reason": "time_limit",
                        "final_delta_x_m": 0.01,
                    },
                }
            ],
        }
    )

    assert summary["ok"] is False
    assert summary["profile_id"] == "hiwonder-ainex"
    failed = summary["failed_tasks"][0]
    assert failed["task_id"] == "walk_forward"
    assert failed["best_candidate"] == {
        "task_id": "walk_forward",
        "controller": "stable_backward",
        "success": False,
        "failed": False,
        "termination_reason": "time_limit",
        "final_delta_x_m": -0.01,
        "final_delta_y_m": 0.0,
        "final_delta_yaw_rad": None,
        "max_abs_imu_roll_rad": None,
        "max_abs_imu_pitch_rad": None,
        "progress_ratio": 0.10,
        "unmet_success_predicates": ["delta_x_m_min"],
    }
    assert failed["most_forward_candidate"] == {
        "task_id": "walk_forward",
        "controller": "falls_forward",
        "success": False,
        "failed": True,
        "termination_reason": "fall",
        "final_delta_x_m": 0.08,
        "final_delta_y_m": 0.0,
        "final_delta_yaw_rad": None,
        "max_abs_imu_roll_rad": None,
        "max_abs_imu_pitch_rad": None,
        "progress_ratio": 0.25,
        "unmet_success_predicates": [
            "delta_x_m_min",
            "no_fall",
        ],
    }
    assert failed["most_progress_candidate"] == {
        "task_id": "walk_forward",
        "controller": "falls_forward",
        "success": False,
        "failed": True,
        "termination_reason": "fall",
        "final_delta_x_m": 0.08,
        "final_delta_y_m": 0.0,
        "final_delta_yaw_rad": None,
        "max_abs_imu_roll_rad": None,
        "max_abs_imu_pitch_rad": None,
        "progress_ratio": 0.25,
        "max_success_window_s": 0.0,
        "unmet_success_predicates": [
            "delta_x_m_min",
            "no_fall",
        ],
    }
    assert failed["passive_baseline"]["controller"] == "zero_action_baseline"
    assert failed["passive_baseline"]["final_delta_x_m"] == 0.01


def test_task_feasibility_summary_handles_missing_report() -> None:
    assert _task_feasibility_summary({}) == {
        "ok": False,
        "all_success": False,
        "n_tasks": 0,
        "n_success": 0,
        "failed_tasks": [],
    }


def test_multi_profile_walk_summary_preserves_passive_false_positive() -> None:
    summary = _multi_profile_walk_summary(
        {
            "task_id": "walk_forward",
            "max_steps": 120,
            "summaries": [
                {
                    "profile_id": "unitree-r1",
                    "active_success": False,
                    "passive_success": True,
                    "valid_walking_evidence": False,
                    "selected_final_delta_x_m": 0.22,
                    "passive_final_delta_x_m": 0.31,
                    "most_forward_controller": "deterministic_smoke",
                    "most_forward_final_delta_x_m": 0.22,
                }
            ],
        }
    )

    assert summary["ok"] is False
    assert summary["n_profiles"] == 1
    assert summary["n_valid_walking"] == 0
    assert summary["n_passive_success"] == 1
    assert summary["profiles"][0]["profile_id"] == "unitree-r1"
    assert summary["profiles"][0]["passive_success"] is True


def test_local_learning_probe_summary_flags_falling_lunge_not_walking() -> None:
    summary = _local_learning_probe_summary(
        {
            "trained": {
                "mean_reward": -105.0,
                "failure_rate": 1.0,
                "mean_steps_survived": 40.0,
                "mean_final_delta_x_m": 0.12,
                "mean_final_delta_y_m": 0.19,
                "mean_final_delta_yaw_rad": 0.51,
            },
            "zero": {
                "mean_reward": -731.0,
                "failure_rate": 0.0,
                "mean_steps_survived": 120.0,
            },
            "manifest_learning": {
                "promotion_passed": False,
                "promotion_blocker": "phase_success_rate_below_threshold",
                "promotion_reasons": ["fall: |pitch|=0.67 > 0.6"],
            },
            "learning_signal_present": True,
            "walking_success": False,
            "reward_delta_trained_minus_zero": 626.0,
            "forward_delta_trained_minus_zero_m": 0.14,
            "verdict": "not_walking_after_8k_single_task",
        }
    )

    assert summary["ok"] is False
    assert summary["learning_signal_present"] is True
    assert summary["learned_motion_signal_present"] is False
    assert summary["walking_success"] is False
    assert summary["trained_is_falling_lunge"] is True
    assert summary["trained_failure_rate"] == 1.0
    assert summary["zero_failure_rate"] == 0.0
    assert summary["promotion_blocker"] == "phase_success_rate_below_threshold"


def test_learned_policy_curriculum_eval_rejects_wrong_signed_motion(
    tmp_path: Path,
) -> None:
    _write_learned_policy_eval(
        tmp_path,
        curriculum_task_overrides={
            "walk_forward": {
                "mean_final_delta_x_m": -0.35,
                "mean_final_tracked_delta_x_m": -0.35,
            }
        },
        native_task_overrides={
            "walk_forward": {
                "mean_final_delta_x_m": -0.35,
                "mean_final_tracked_delta_x_m": -0.35,
            }
        },
    )

    summary = _learned_policy_curriculum_eval_summary(tmp_path)

    assert summary["ok"] is False
    assert "curriculum.all_requested_tasks_numeric_motion" in summary["failed_checks"]
    assert "native.per_task_numeric_motion" in summary["failed_checks"]
    failed = summary["failed_tasks"][0]
    assert failed["task_id"] == "walk_forward"
    assert "mean_final_tracked_delta_x_m" in failed["numeric_motion_fail_reasons"]
    assert "mean_final_tracked_delta_x_m" in failed["native_numeric_motion_fail_reasons"]


def test_learned_policy_curriculum_eval_rejects_missing_locomotion_checks(
    tmp_path: Path,
) -> None:
    checks = _curriculum_physical_checks("walk_forward")
    checks.pop("min_swing_foot_clearance_m")
    checks.pop("max_foot_slip_m_s")
    checks.pop("max_self_collision_count")
    _write_learned_policy_eval(
        tmp_path,
        curriculum_task_overrides={"walk_forward": {"physical_checks": checks}},
    )

    summary = _learned_policy_curriculum_eval_summary(tmp_path)

    assert summary["ok"] is False
    assert "curriculum.all_requested_tasks_physical_success" in summary["failed_checks"]
    assert summary["task_checks"]["walk_forward"] is False
    assert summary["native_task_checks"]["walk_forward"] is True
    assert summary["failed_tasks"][0]["failed_physical_checks"] == []


def test_local_learning_probe_summary_loads_training_manifest(tmp_path: Path) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": -514.0,
                "learning_delta_x_m": 0.16,
                "failure_rate": 1.0,
                "mean_final_delta_x_m": 0.16,
                "mean_final_delta_y_m": -0.06,
                "mean_final_delta_yaw_rad": -0.79,
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["ok"] is False
    assert summary["learning_signal_present"] is False
    assert summary["learned_motion_signal_present"] is False
    assert summary["walking_success"] is False
    assert summary["trained_is_falling_lunge"] is True
    assert summary["reward_delta_trained_minus_zero"] == -514.0
    assert summary["promotion_blocker"] == "phase_success_rate_below_threshold"
    assert summary["verdict"] == "not_walking_after_progress_8k"


def test_local_learning_probe_summary_rejects_stable_standstill_manifest(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": 150.0,
                "learning_delta_x_m": -0.003,
                "failure_rate": 0.0,
                "mean_final_delta_x_m": -0.002,
                "mean_final_delta_y_m": -0.017,
                "mean_final_delta_yaw_rad": 0.041,
                "mean_final_tracked_delta_x_m": -0.030,
                "physical_checks": {
                  "tracked_delta_x_forward": false,
                  "yaw_drift_bound": true,
                  "no_fall": true,
                  "min_alternating_foot_contacts": false
                },
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["ok"] is False
    assert summary["learning_signal_present"] is False
    assert summary["learned_motion_signal_present"] is False
    assert summary["trained_is_falling_lunge"] is False
    assert summary["trained_is_stable_standstill"] is True
    assert summary["trained_has_no_forward_motion"] is True
    assert summary["trained_mean_final_tracked_delta_x_m"] == -0.03
    assert summary["verdict"] == "stable_standstill_after_yaw_contact_8k"


def test_local_learning_probe_summary_rejects_no_forward_motion_manifest(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": -22.0,
                "learning_delta_x_m": -0.002,
                "failure_rate": 0.0,
                "mean_final_delta_yaw_rad": -0.447,
                "mean_final_tracked_delta_x_m": -0.036,
                "physical_checks": {
                  "tracked_delta_x_forward": false,
                  "yaw_drift_bound": false,
                  "no_fall": true,
                  "min_alternating_foot_contacts": false
                },
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["learning_signal_present"] is False
    assert summary["learned_motion_signal_present"] is False
    assert summary["trained_is_stable_standstill"] is False
    assert summary["trained_has_no_forward_motion"] is True
    assert summary["verdict"] == "no_forward_motion_after_progress_8k"


def test_local_learning_probe_summary_flags_backward_fall_manifest(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "history": [
            {"promotion_reasons": ["fall: |pitch|=0.61 > 0.6"]}
          ],
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": 35.0,
                "learning_delta_x_m": -0.126,
                "failure_rate": 1.0,
                "mean_final_delta_yaw_rad": 0.041,
                "mean_final_tracked_delta_x_m": -0.203,
                "physical_checks": {
                  "tracked_delta_x_forward": false,
                  "yaw_drift_bound": true,
                  "no_fall": false,
                  "min_alternating_foot_contacts": false
                },
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["learning_signal_present"] is False
    assert summary["trained_is_backward_fall"] is True
    assert summary["trained_has_no_forward_motion"] is True
    assert summary["promotion_reasons"] == ["fall: |pitch|=0.61 > 0.6"]
    assert summary["verdict"] == "backward_fall_after_gait_prior_8k"


def test_local_learning_probe_summary_flags_stale_tracked_body_manifest(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "profile_id": "hiwonder-ainex",
          "phase_promotion": {
            "phases": [
              {
                "tracked_body_name": "head_tilt_link",
                "learning_return_delta": 500.0,
                "learning_delta_x_m": 0.35,
                "failure_rate": 0.0,
                "mean_final_tracked_delta_x_m": 0.35,
                "physical_checks": {
                  "tracked_delta_x_forward": true,
                  "yaw_drift_bound": true,
                  "no_fall": true,
                  "min_alternating_foot_contacts": true
                },
                "promotion_passed": true
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["ok"] is False
    assert summary["walking_success"] is False
    assert summary["expected_tracked_body_name"] == "body_link"
    assert summary["tracked_body_name"] == "head_tilt_link"
    assert summary["stale_tracked_body"] is True
    assert summary["verdict"] == "stale_tracked_body_training_probe"


def test_local_learning_probe_summary_flags_partial_stepping_below_distance(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": 1191.0,
                "learning_delta_x_m": 0.026,
                "failure_rate": 0.0,
                "mean_final_delta_yaw_rad": -0.037,
                "mean_final_tracked_delta_x_m": 0.042,
                "physical_checks": {
                  "tracked_delta_x_forward": false,
                  "yaw_drift_bound": true,
                  "no_fall": true,
                  "min_alternating_foot_contacts": true
                },
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["learning_signal_present"] is False
    assert summary["trained_has_alternating_contacts"] is True
    assert summary["trained_is_partial_stepping_below_distance"] is True
    assert summary["trained_has_no_forward_motion"] is True
    assert summary["walking_success"] is False
    assert summary["verdict"] == "partial_stepping_below_distance_after_scale030_8k"


def test_local_learning_probe_summary_flags_stable_forward_shuffle(
    tmp_path: Path,
) -> None:
    manifest_dir = tmp_path / "checkpoint"
    manifest_dir.mkdir()
    (manifest_dir / "manifest.json").write_text(
        """
        {
          "phase_promotion": {
            "phases": [
              {
                "learning_return_delta": 425.0,
                "learning_delta_x_m": 0.064,
                "failure_rate": 0.0,
                "mean_final_delta_yaw_rad": 0.174,
                "mean_final_tracked_delta_x_m": 0.065,
                "physical_checks": {
                  "tracked_delta_x_forward": false,
                  "yaw_drift_bound": true,
                  "no_fall": true,
                  "min_alternating_foot_contacts": false
                },
                "promotion_passed": false,
                "blocker": "phase_success_rate_below_threshold"
              }
            ]
          }
        }
        """,
        encoding="utf-8",
    )

    summary = _local_learning_probe_from_dir(tmp_path)

    assert summary["learning_signal_present"] is False
    assert summary["learned_motion_signal_present"] is True
    assert summary["trained_has_no_forward_motion"] is False
    assert summary["trained_is_stable_forward_shuffle_below_distance"] is True
    assert summary["trained_is_learned_motion_without_walking"] is True
    assert summary["walking_success"] is False
    assert (
        summary["verdict"]
        == "stable_forward_shuffle_below_distance_after_scale015_fall100_8k"
    )


def test_near_gait_visual_summary_accepts_motion_but_rejects_walking(
    tmp_path: Path,
) -> None:
    report_path = tmp_path / "near_gait.json"
    video_path = tmp_path / "near_gait.mp4"
    contact_sheet_path = tmp_path / "near_gait_contact.jpg"
    video_path.write_bytes(b"0" * 12_000)
    contact_sheet_path.write_bytes(b"1" * 6_000)
    report_path.write_text("{}", encoding="utf-8")

    summary = _near_gait_visual_summary(
        {
            "schema": "hiwonder-near-gait-visual-evidence-v1",
            "video": str(video_path),
            "contact_sheet": str(contact_sheet_path),
            "steps": 64,
            "telemetry": [{} for _ in range(64)],
            "motion_evidence": True,
            "walking_success": False,
            "done_reason": "fall",
            "final_tracked_delta_x_m": 0.36,
            "final_tracked_delta_y_m": 0.05,
            "final_delta_yaw_rad": 0.1,
            "foot_contact_switches": 4,
        },
        report_path=report_path,
    )

    assert summary["artifact_ok"] is True
    assert summary["motion_evidence"] is True
    assert summary["active_motion_evidence"] is True
    assert summary["walking_success"] is False
    assert summary["walking_rejected"] is True
    assert summary["ok"] is False
    assert summary["failed_checks"] == []


def test_near_gait_visual_summary_rejects_missing_video(tmp_path: Path) -> None:
    report_path = tmp_path / "near_gait.json"
    report_path.write_text("{}", encoding="utf-8")

    summary = _near_gait_visual_summary(
        {
            "schema": "hiwonder-near-gait-visual-evidence-v1",
            "video": str(tmp_path / "missing.mp4"),
            "contact_sheet": str(tmp_path / "missing.jpg"),
            "steps": 1,
            "telemetry": [{}],
            "motion_evidence": True,
            "walking_success": False,
            "done_reason": "fall",
            "final_tracked_delta_x_m": 0.36,
            "final_tracked_delta_y_m": 0.05,
            "final_delta_yaw_rad": 0.1,
            "foot_contact_switches": 4,
        },
        report_path=report_path,
    )

    assert summary["artifact_ok"] is False
    assert summary["motion_evidence"] is False
    assert summary["active_motion_evidence"] is False
    assert "video_present" in summary["failed_checks"]
    assert "contact_sheet_present" in summary["failed_checks"]
    assert "telemetry_length" in summary["failed_checks"]


def test_fresh_obstacle_smoke_summary_surfaces_demo_and_trace_facts(
    tmp_path: Path,
) -> None:
    video_path = tmp_path / "obstacle_course_demo.mp4"
    video_path.write_bytes(b"0" * 12_000)
    smoke_report = {
        "ok": True,
        "configured_learners": ["alberta"],
        "motion": {"alberta": {"forward_progress_mean_m": 1.2}},
        "deltas": {"alberta_minus_ppo_acc": 2.0},
        "obstacle_baseline": {
            "baseline_is_control": True,
            "learning_beats_baseline": True,
        },
        "obstacle_trace_rollouts": {
            "ok": True,
            "all_trace_summaries_consistent": True,
            "any_required_learner_successful_final_clear": True,
            "alberta_successful_final_clear": True,
            "alberta_final_clear_advantage": True,
        },
        "demo": {
            "schema": "robot-alberta-obstacle-demo-v1",
            "ok": True,
            "frames": 3,
            "fps": 2,
            "video": str(video_path),
            "video_bytes": 12_000,
            "learners": ["alberta"],
            "learner_results": {
                "alberta": {"has_trajectory_traces": True},
            },
        },
    }
    smoke_bundle = {
        "summary": {"learners": ["alberta"]},
        "results": [
            {
                "name": "alberta",
                "trajectory_matrix": [
                    [
                        {
                            "task_id": 0,
                            "obstacle": {"x": 0.0, "y": 0.0, "radius": 0.25},
                            "goal": [1.2, 0.0],
                            "summary": {
                                "success_rate": 1.0,
                                "collision_rate": 0.0,
                                "passed_obstacle_rate": 1.0,
                                "mean_forward_progress_m": 1.4,
                                "min_obstacle_clearance_m": 0.1,
                            },
                            "steps": [
                                {
                                    "step": 0,
                                    "x": -1.0,
                                    "y": 0.0,
                                    "forward_progress_m": 0.0,
                                    "passed_obstacle": False,
                                    "collision": False,
                                },
                                {
                                    "step": 1,
                                    "x": 0.3,
                                    "y": 0.1,
                                    "forward_progress_m": 1.3,
                                    "passed_obstacle": True,
                                    "collision": False,
                                },
                            ],
                        }
                    ]
                ],
            }
        ],
    }

    summary = _fresh_obstacle_smoke_summary(
        smoke_report,
        smoke_bundle,
        fresh_obstacle_dir=tmp_path,
    )

    assert summary["artifact_ok"] is True
    assert summary["benchmark_model"] == "2d_point_robot"
    assert summary["proves_alberta_obstacle_learning"] is True
    assert summary["proves_robot_walking"] is False
    assert "not MuJoCo or real robot walking" in summary["robot_walking_evidence_note"]
    assert summary["failed_checks"] == []
    assert summary["checks"]["alberta_successful_final_clear"] is True
    assert summary["checks"]["alberta_final_clear_advantage"] is True
    assert summary["demo"]["video_bytes_json"] == 12_000
    assert summary["demo"]["video_bytes_file"] == 12_000
    trace = summary["trajectory_samples"]["alberta"]
    assert trace["forward_progress_m"] == 1.3
    assert trace["reached_obstacle_x"] is True
    assert trace["cleared_obstacle_centerline"] is True
    assert trace["passed_obstacle_ever"] is True
    assert trace["matrix_row"] == 0
    assert trace["matrix_col"] == 0


def test_fresh_obstacle_smoke_summary_prefers_successful_clear_sample(
    tmp_path: Path,
) -> None:
    video_path = tmp_path / "obstacle_course_demo.mp4"
    video_path.write_bytes(b"0" * 12_000)
    smoke_report = {
        "ok": True,
        "configured_learners": ["alberta"],
        "obstacle_baseline": {
            "baseline_is_control": True,
            "learning_beats_baseline": True,
        },
        "obstacle_trace_rollouts": {
            "ok": True,
            "all_trace_summaries_consistent": True,
            "any_required_learner_successful_final_clear": True,
            "alberta_successful_final_clear": True,
            "alberta_final_clear_advantage": True,
        },
        "demo": {
            "schema": "robot-alberta-obstacle-demo-v1",
            "ok": True,
            "frames": 3,
            "video": str(video_path),
            "video_bytes": 12_000,
            "learner_results": {
                "alberta": {"has_trajectory_traces": True},
            },
        },
    }
    failed_late_trace = {
        "task_id": 1,
        "obstacle": {"x": 0.0, "y": 0.0, "radius": 0.25},
        "goal": [1.2, 0.0],
        "summary": {
            "success_rate": 0.0,
            "collision_rate": 1.0,
            "passed_obstacle_rate": 0.0,
            "mean_forward_progress_m": 0.9,
        },
        "steps": [
            {
                "x": -1.0,
                "y": 0.0,
                "collision": False,
                "passed_obstacle": False,
                "forward_progress_m": 0.0,
            },
            {
                "x": -0.1,
                "y": 0.1,
                "collision": True,
                "passed_obstacle": False,
                "forward_progress_m": 0.9,
            },
        ],
    }
    successful_clear_trace = {
        "task_id": 0,
        "obstacle": {"x": 0.0, "y": 0.0, "radius": 0.25},
        "goal": [1.2, 0.0],
        "summary": {
            "success_rate": 1.0,
            "collision_rate": 0.0,
            "passed_obstacle_rate": 1.0,
            "mean_forward_progress_m": 2.2,
        },
        "steps": [
            {
                "x": -1.0,
                "y": 0.0,
                "collision": False,
                "passed_obstacle": False,
                "forward_progress_m": 0.0,
            },
            {
                "x": 1.2,
                "y": 0.1,
                "collision": False,
                "passed_obstacle": True,
                "goal_reached": True,
                "forward_progress_m": 2.2,
            },
        ],
    }

    summary = _fresh_obstacle_smoke_summary(
        smoke_report,
        {
            "results": [
                {
                    "name": "alberta",
                    "trajectory_matrix": [
                        [successful_clear_trace, failed_late_trace],
                        [failed_late_trace, failed_late_trace],
                    ],
                }
            ],
        },
        fresh_obstacle_dir=tmp_path,
    )

    trace = summary["trajectory_samples"]["alberta"]
    assert trace["task_id"] == 0
    assert trace["matrix_row"] == 0
    assert trace["matrix_col"] == 0
    assert trace["passed_obstacle_ever"] is True
    assert trace["collision_ever"] is False


def test_fresh_obstacle_smoke_summary_rejects_missing_demo_video(
    tmp_path: Path,
) -> None:
    summary = _fresh_obstacle_smoke_summary(
        {
            "ok": True,
            "configured_learners": ["alberta"],
            "obstacle_baseline": {
                "baseline_is_control": True,
                "learning_beats_baseline": True,
            },
            "obstacle_trace_rollouts": {
                "ok": True,
                "all_trace_summaries_consistent": True,
                "any_required_learner_successful_final_clear": True,
                "alberta_successful_final_clear": True,
                "alberta_final_clear_advantage": True,
            },
            "demo": {
                "schema": "robot-alberta-obstacle-demo-v1",
                "ok": True,
                "frames": 3,
                "video": str(tmp_path / "missing.mp4"),
                "video_bytes": 12_000,
                "learner_results": {
                    "alberta": {"has_trajectory_traces": True},
                },
            },
        },
        {
            "results": [
                {
                    "name": "alberta",
                    "trajectory_matrix": [[{"steps": [{"x": -1.0}, {"x": 0.1}]}]],
                }
            ],
        },
        fresh_obstacle_dir=tmp_path,
    )

    assert summary["artifact_ok"] is False
    assert summary["benchmark_model"] == "2d_point_robot"
    assert summary["proves_robot_walking"] is False
    assert "demo_video_present" in summary["failed_checks"]
    assert "demo_video_nontrivial" in summary["failed_checks"]
    assert "demo_video_size_matches_json" in summary["failed_checks"]
