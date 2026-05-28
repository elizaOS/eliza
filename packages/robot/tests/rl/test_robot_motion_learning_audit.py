from __future__ import annotations

from scripts.audit_robot_motion_learning import (
    _multi_profile_walk_summary,
    _task_feasibility_summary,
)


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
                            "progress_ratio": 0.25,
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
                            "progress_ratio": 0.10,
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
        "final_delta_y_m": None,
        "final_delta_yaw_rad": None,
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
        "final_delta_y_m": None,
        "final_delta_yaw_rad": None,
        "progress_ratio": 0.25,
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
