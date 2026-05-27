from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import audit_alberta_objective_completion as audit


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _minimal_package(root: Path) -> None:
    _write_json(
        root / "evidence" / "full_training_preflight" / "preflight_report.json",
        {
            "ok": True,
            "default_profiles": ["hiwonder-ainex", "asimov-1", "unitree-g1"],
            "launch_template": {"hygiene": {"ok": True}},
        },
    )
    _write_json(
        root / "evidence" / "video_review" / "video_review.json",
        {"ok": True, "video_count": 3},
    )
    _write_json(
        root / "evidence" / "agent_videos" / "manifest.json",
        {"profiles": [{"profile": "asimov-1"}]},
    )
    _write_json(
        root / "evidence" / "backend_compare_smoke" / "validation_report.json",
        {"ok": True},
    )
    _write_json(
        root / "evidence" / "alberta_obstacle_course_smoke" / "validation_report.json",
        {"ok": True},
    )


def _complete_run(root: Path) -> None:
    requirements = {
        "brax_full_training_run_ok": True,
        "brax_production_checkpoint_ok": True,
        "backend_eval_config_ok": True,
        "backend_alberta_vs_ppo_delta_ok": True,
        "backend_winner_consistent": True,
        "obstacle_course_alberta_acc_gte_ppo": True,
        "obstacle_course_alberta_forgetting_lte_ppo": True,
        "production_policy_videos_ok": True,
        "video_all_reviewed_ok": True,
        "video_min_visual_progress_met": True,
        "curriculum_eval_ok": True,
        "curriculum_eval_present": True,
        "curriculum_eval_checkpoint_bound": True,
        "curriculum_eval_all_tasks_success": True,
        "curriculum_eval_pass_rate": True,
    }
    _write_json(
        root / "training_comparison_report.json",
        {
            "ok": True,
            "completion_requirements": requirements,
            "backend_comparison": {
                "alberta_delta_vs_ppo": 1.0,
                "winner_by_mean_reward": "alberta",
            },
            "continual_learning": {
                "obstacle_course": {
                    "present": True,
                    "alberta_acc_delta_vs_ppo": 1.0,
                    "alberta_forgetting_delta_vs_ppo": -0.1,
                }
            },
            "video_review": {"ok": True, "video_count": 5},
        },
    )
    _write_json(root / "closeout_status.json", {"ok": True, "state": "complete"})
    _write_json(root / "finalization_report.json", {"ok": True})
    _write_json(root / "artifact_inventory.json", {"ok": True, "present_count": 88, "required_count": 88})
    _write_json(
        root / "validation_report.json",
        {
            "ok": True,
            "reports": {
                "multi_robot_readiness": {
                    "ok": True,
                    "alberta": {"ok": True},
                    "profiles": {"asimov-1": {"ok": True}},
                },
                "curriculum_eval": {
                    "ok": True,
                    "programmatic_pass_rate": 1.0,
                    "task_checks": {"stand_up": True, "walk_forward": True},
                },
                "curriculum_eval_native": {"ok": True},
            },
        },
    )
    _write_json(
        root / "relaunch_plan.json",
        {"preflight": {"ok": True}, "relaunch_ready": False, "recommendation": "not-needed"},
    )


def _local_alberta_evidence(root: Path) -> None:
    _write_json(
        root / "evidence" / "full_training_preflight" / "multi_robot_readiness.json",
        {
            "ok": True,
            "alberta": {"ok": True},
            "profiles": {
                "asimov-1": {"zero_action_survival_ok": True},
                "unitree-r1": {"zero_action_survival_ok": True},
            },
        },
    )
    _write_json(
        root / "evidence" / "full_training_preflight" / "preflight_report.json",
        {
            "ok": True,
            "default_profiles": ["asimov-1", "unitree-r1"],
            "launch_template": {"hygiene": {"ok": True}},
            "brax_validation": {"ok": True},
        },
    )
    _write_json(
        root / "evidence" / "backend_compare_local" / "asimov-1" / "validation_report.json",
        {
            "ok": True,
            "checks": {
                "alberta_vs_ppo_delta": True,
                "winner_consistent": True,
                "eval_rollout_depth": True,
            },
            "deltas": {"alberta_minus_ppo_mean_reward": 1.0},
        },
    )
    _write_json(
        root / "evidence" / "backend_compare_local" / "asimov-1" / "comparison.json",
        {
            "profile_id": "asimov-1",
            "steps": 4000,
            "winner_by_mean_reward": "alberta",
        },
    )
    _write_json(
        root / "evidence" / "alberta_obstacle_course_local_4task" / "validation_report.json",
        {
            "ok": True,
            "config": {"n_tasks": 4},
            "checks": {
                "alberta_acc_gte_ppo": True,
                "alberta_forgetting_lte_ppo": True,
                "demo_video": True,
                "demo_json": True,
            },
            "deltas": {
                "alberta_acc_minus_ppo": 1.0,
                "alberta_forgetting_minus_ppo": -0.1,
            },
        },
    )
    _write_json(
        root / "evidence" / "alberta_obstacle_course_sac_smoke" / "validation_report.json",
        {"ok": True},
    )
    _write_json(
        root / "evidence" / "brax_mjx_contract_artifact" / "validation_report.json",
        {
            "ok": True,
            "contract_only": True,
            "production_training": False,
            "manifest": {"regime": "brax_ppo", "profile_id": "asimov-1"},
        },
    )
    _write_json(
        root / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
        {
            "ok": True,
            "video_count": 2,
            "all_videos_reviewed_good": True,
            "telemetry": {"present_count": 2, "failed_count": 0},
        },
    )
    _write_json(
        root / "evidence" / "alberta_checkpoint_video_review" / "validation_report.json",
        {
            "ok": True,
            "profiles": ["asimov-1", "unitree-r1"],
            "commands": ["stand up", "walk forward"],
            "expected_video_count": 2,
            "checks": {"videos": True, "review": True},
            "video_reports": [
                {"policy_source_ok": True},
                {"policy_source_ok": True},
            ],
        },
    )


def test_objective_audit_rejects_missing_production_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    package = tmp_path / "pkg"
    run = tmp_path / "run"
    _minimal_package(package)
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(run / "finalization_report.json", {"ok": False})
    _write_json(run / "artifact_inventory.json", {"ok": False, "present_count": 1, "required_count": 88})
    _write_json(
        run / "validation_report.json",
        {"ok": False, "reports": {"multi_robot_readiness": {"ok": False}}},
    )
    _write_json(run / "training_comparison_report.json", {"ok": False})
    _write_json(
        run / "relaunch_plan.json",
        {"preflight": {"ok": True}, "relaunch_ready": False, "recommendation": "wait"},
    )
    monkeypatch.setattr(
        audit,
        "validate_alberta_vendoring",
        lambda: {"ok": True, "vendored_commit": "abc"},
    )

    report = audit.audit_alberta_objective_completion(
        package_root=package,
        nebius_run_root=run,
    )

    assert report["ok"] is False
    assert "nebius_production_training_complete" in report["failed"]
    assert "production_curriculum_eval_passed" in report["failed"]
    assert "alberta_vs_ppo_side_by_side_comparison" in report["failed"]
    assert (package / "evidence" / "alberta_objective_completion_audit.json").is_file()
    assert (package / "evidence" / "alberta_objective_completion_audit.md").is_file()


def test_objective_audit_accepts_complete_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    package = tmp_path / "pkg"
    run = tmp_path / "run"
    _minimal_package(package)
    _complete_run(run)
    monkeypatch.setattr(
        audit,
        "validate_alberta_vendoring",
        lambda: {"ok": True, "vendored_commit": "abc"},
    )

    report = audit.audit_alberta_objective_completion(
        package_root=package,
        nebius_run_root=run,
    )

    assert report["ok"] is True
    assert report["failed"] == []
    assert {
        "alberta_framework_integrated",
        "continual_learning_obstacle_demo_no_forgetting",
        "production_robot_policy_videos_reviewed",
        "production_curriculum_eval_passed",
    }.issubset(report["passed"])


def test_objective_audit_rejects_failed_curriculum_eval(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    package = tmp_path / "pkg"
    run = tmp_path / "run"
    _minimal_package(package)
    _complete_run(run)
    training_report = json.loads((run / "training_comparison_report.json").read_text())
    training_report["ok"] = False
    training_report["completion_requirements"]["curriculum_eval_ok"] = False
    training_report["completion_requirements"][
        "curriculum_eval_all_tasks_success"
    ] = False
    training_report["completion_requirements"]["curriculum_eval_pass_rate"] = False
    _write_json(run / "training_comparison_report.json", training_report)
    validation = json.loads((run / "validation_report.json").read_text())
    validation["ok"] = False
    validation["reports"]["curriculum_eval"] = {
        "ok": False,
        "programmatic_pass_rate": 0.0,
        "task_checks": {"stand_up": False, "walk_forward": False},
    }
    validation["reports"]["curriculum_eval_native"] = {"ok": True}
    _write_json(run / "validation_report.json", validation)
    monkeypatch.setattr(
        audit,
        "validate_alberta_vendoring",
        lambda: {"ok": True, "vendored_commit": "abc"},
    )

    report = audit.audit_alberta_objective_completion(
        package_root=package,
        nebius_run_root=run,
    )

    assert report["ok"] is False
    assert "production_curriculum_eval_passed" in report["failed"]
    curriculum = next(
        item
        for item in report["requirements"]
        if item["name"] == "production_curriculum_eval_passed"
    )
    assert curriculum["evidence"]["programmatic_pass_rate"] == 0.0
    assert curriculum["evidence"]["validation_curriculum_eval_native_ok"] is True


def test_objective_audit_records_local_checkpoint_video_and_brax_contract_proof(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    package = tmp_path / "pkg"
    run = tmp_path / "run"
    _minimal_package(package)
    _local_alberta_evidence(package)
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(run / "finalization_report.json", {"ok": False})
    _write_json(run / "artifact_inventory.json", {"ok": False, "present_count": 1, "required_count": 88})
    _write_json(run / "validation_report.json", {"ok": False})
    _write_json(run / "training_comparison_report.json", {"ok": False})
    _write_json(
        run / "relaunch_plan.json",
        {"relaunch_ready": True, "recommendation": "ready_to_launch_clean_run"},
    )
    monkeypatch.setattr(
        audit,
        "validate_alberta_vendoring",
        lambda: {"ok": True, "vendored_commit": "abc"},
    )

    report = audit.audit_alberta_objective_completion(
        package_root=package,
        nebius_run_root=run,
    )

    assert report["ok"] is False
    assert "traditional_and_sota_baselines_available" in report["passed"]
    assert "checkpoint_bound_local_policy_videos_reviewed" in report["passed"]
    assert "production_robot_policy_videos_reviewed" in report["failed"]
    baseline = next(
        item for item in report["requirements"] if item["name"] == "traditional_and_sota_baselines_available"
    )
    assert baseline["evidence"]["brax_contract_artifact_ok"] is True
    assert baseline["evidence"]["brax_contract_only"] is True
    videos = next(
        item for item in report["requirements"] if item["name"] == "checkpoint_bound_local_policy_videos_reviewed"
    )
    assert videos["evidence"]["policy_source_ok_count"] == 2
