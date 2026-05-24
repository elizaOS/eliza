from __future__ import annotations

import json
from pathlib import Path

from scripts import closeout_nebius_full_training_run as closeout


def test_closeout_returns_running_and_writes_artifacts(monkeypatch, tmp_path: Path) -> None:
    def fake_monitor(**kwargs):
        return {
            "ok": False,
            "state": "running",
            "summary": {
                "missing_gates": ["success_marker"],
                "completed_stage_count": 1,
                "total_stage_count": 6,
            },
        }

    monkeypatch.setattr(closeout, "monitor_nebius_full_training_run", fake_monitor)
    monkeypatch.setattr(
        closeout,
        "finalize_nebius_full_training_run",
        lambda _dest: {"ok": False, "missing_gates": ["success_marker"]},
    )
    monkeypatch.setattr(
        closeout,
        "generate_nebius_training_report",
        lambda _dest: {
            "ok": False,
            "missing_gates": ["success_marker"],
            "backend_comparison": {"present": False},
            "continual_learning": {
                "joint_reach": {},
                "obstacle_course": {},
            },
            "sota_baseline": {},
            "video_review": {"present": True},
        },
    )
    monkeypatch.setattr(
        closeout,
        "inventory_nebius_training_artifacts",
        lambda _dest: {
            "ok": False,
            "present_count": 1,
            "required_count": 2,
            "missing": ["status_success"],
            "artifacts": [],
        },
    )
    monkeypatch.setattr(
        closeout,
        "audit_alberta_objective_completion",
        lambda **_kwargs: {
            "ok": False,
            "passed": [],
            "failed": ["nebius_production_training_complete"],
            "requirements": [],
        },
    )

    status = closeout.closeout_nebius_full_training_run(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=tmp_path,
        skip_sync=True,
    )

    assert status["ok"] is False
    assert status["state"] == "running"
    assert status["missing_gates"] == ["success_marker"]
    assert (tmp_path / "closeout_status.json").is_file()
    assert (tmp_path / "closeout_summary.md").is_file()
    assert (tmp_path / "artifact_inventory.json").is_file()
    assert (tmp_path / "objective_completion_audit.json").is_file()
    assert json.loads((tmp_path / "training_comparison_report.json").read_text())["ok"] is False
    assert status["objective_audit"]["ok"] is False


def test_closeout_returns_complete_when_all_steps_are_green(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        closeout,
        "monitor_nebius_full_training_run",
        lambda **_kwargs: {"ok": True, "state": "complete", "summary": {"missing_gates": []}},
    )
    monkeypatch.setattr(
        closeout,
        "finalize_nebius_full_training_run",
        lambda _dest: {"ok": True, "missing_gates": []},
    )
    monkeypatch.setattr(
        closeout,
        "generate_nebius_training_report",
        lambda _dest: {
            "ok": True,
            "missing_gates": [],
            "backend_comparison": {"winner_by_mean_reward": "alberta"},
            "continual_learning": {
                "joint_reach": {},
                "obstacle_course": {},
            },
            "sota_baseline": {},
            "video_review": {"ok": True},
        },
    )
    monkeypatch.setattr(
        closeout,
        "inventory_nebius_training_artifacts",
        lambda _dest: {
            "ok": True,
            "present_count": 2,
            "required_count": 2,
            "missing": [],
            "artifacts": [],
        },
    )
    monkeypatch.setattr(
        closeout,
        "audit_alberta_objective_completion",
        lambda **_kwargs: {
            "ok": True,
            "passed": ["all"],
            "failed": [],
            "requirements": [],
        },
    )

    status = closeout.closeout_nebius_full_training_run(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=tmp_path,
        skip_sync=True,
    )

    assert status["ok"] is True
    assert status["state"] == "complete"
    assert status["missing_gates"] == []
    assert status["artifact_inventory"]["ok"] is True
    assert status["objective_audit"]["ok"] is True


def test_closeout_refuses_complete_state_when_inventory_missing(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        closeout,
        "monitor_nebius_full_training_run",
        lambda **_kwargs: {"ok": True, "state": "complete", "summary": {"missing_gates": []}},
    )
    monkeypatch.setattr(
        closeout,
        "finalize_nebius_full_training_run",
        lambda _dest: {"ok": True, "missing_gates": []},
    )
    monkeypatch.setattr(
        closeout,
        "generate_nebius_training_report",
        lambda _dest: {
            "ok": True,
            "missing_gates": [],
            "backend_comparison": {},
            "continual_learning": {"joint_reach": {}, "obstacle_course": {}},
            "sota_baseline": {},
            "video_review": {},
        },
    )
    monkeypatch.setattr(
        closeout,
        "inventory_nebius_training_artifacts",
        lambda _dest: {
            "ok": False,
            "present_count": 1,
            "required_count": 2,
            "missing": ["runtime_watch_history"],
            "artifacts": [],
        },
    )
    monkeypatch.setattr(
        closeout,
        "audit_alberta_objective_completion",
        lambda **_kwargs: {
            "ok": False,
            "passed": ["alberta_framework_integrated"],
            "failed": ["nebius_production_training_complete"],
            "requirements": [],
        },
    )

    status = closeout.closeout_nebius_full_training_run(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=tmp_path,
        skip_sync=True,
    )

    assert status["ok"] is False
    assert status["state"] == "invalid"
    assert status["missing_gates"] == ["runtime_watch_history"]


def test_closeout_refuses_complete_state_when_objective_audit_fails(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        closeout,
        "monitor_nebius_full_training_run",
        lambda **_kwargs: {"ok": True, "state": "complete", "summary": {"missing_gates": []}},
    )
    monkeypatch.setattr(
        closeout,
        "finalize_nebius_full_training_run",
        lambda _dest: {"ok": True, "missing_gates": []},
    )
    monkeypatch.setattr(
        closeout,
        "generate_nebius_training_report",
        lambda _dest: {
            "ok": True,
            "missing_gates": [],
            "backend_comparison": {},
            "continual_learning": {"joint_reach": {}, "obstacle_course": {}},
            "sota_baseline": {},
            "video_review": {},
        },
    )
    monkeypatch.setattr(
        closeout,
        "inventory_nebius_training_artifacts",
        lambda _dest: {
            "ok": True,
            "present_count": 88,
            "required_count": 88,
            "missing": [],
            "artifacts": [],
        },
    )
    monkeypatch.setattr(
        closeout,
        "audit_alberta_objective_completion",
        lambda **_kwargs: {
            "ok": False,
            "passed": ["alberta_framework_integrated"],
            "failed": ["production_robot_policy_videos_reviewed"],
            "requirements": [],
        },
    )

    status = closeout.closeout_nebius_full_training_run(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=tmp_path,
        skip_sync=True,
    )

    assert status["ok"] is False
    assert status["state"] == "invalid"
    assert status["missing_gates"] == ["production_robot_policy_videos_reviewed"]
    assert status["objective_audit"]["ok"] is False


def test_closeout_cli_returns_one_for_running(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        closeout,
        "closeout_nebius_full_training_run",
        lambda **_kwargs: {"ok": False, "state": "running"},
    )

    rc = closeout.main(
        [
            "--run-id",
            "robot-full-test",
            "--bucket",
            "bucket",
            "--dest",
            str(tmp_path),
            "--skip-sync",
            "--no-deep-validators",
        ]
    )

    assert rc == 1
