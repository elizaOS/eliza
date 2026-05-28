from __future__ import annotations

from scripts.audit_multi_profile_walk_feasibility import _summarize_profile


def test_summarize_profile_rejects_passive_walk_success() -> None:
    summary = _summarize_profile(
        "unitree-r1",
        {
            "tasks": [
                {
                    "success": False,
                    "controller": "deterministic_smoke",
                    "final_delta_x_m": 0.2,
                    "termination_reason": "fall",
                    "candidate_results": [
                        {
                            "controller": "deterministic_smoke",
                            "final_delta_x_m": 0.2,
                            "termination_reason": "fall",
                        }
                    ],
                    "passive_baseline": {
                        "success": True,
                        "final_delta_x_m": 0.31,
                        "termination_reason": None,
                    },
                }
            ]
        },
    )

    assert summary["active_success"] is False
    assert summary["passive_success"] is True
    assert summary["valid_walking_evidence"] is False


def test_summarize_profile_accepts_active_nonpassive_success() -> None:
    summary = _summarize_profile(
        "robot-a",
        {
            "tasks": [
                {
                    "success": True,
                    "controller": "candidate",
                    "final_delta_x_m": 0.35,
                    "termination_reason": None,
                    "candidate_results": [
                        {
                            "controller": "candidate",
                            "final_delta_x_m": 0.35,
                            "termination_reason": None,
                        }
                    ],
                    "passive_baseline": {
                        "success": False,
                        "final_delta_x_m": 0.01,
                        "termination_reason": "time_limit",
                    },
                }
            ]
        },
    )

    assert summary["active_success"] is True
    assert summary["passive_success"] is False
    assert summary["valid_walking_evidence"] is True
