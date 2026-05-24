from __future__ import annotations

import json
from pathlib import Path

from scripts.finalize_nebius_full_training_run import (
    finalize_nebius_full_training_run,
    main,
)


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def test_finalize_refuses_running_monitor(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(
        run / "monitor_status.json",
        {
            "run_id": "robot-full-test",
            "ok": False,
            "state": "running",
            "summary": {"missing_gates": ["success_marker"]},
        },
    )
    _write_json(
        run / "validation_report.json",
        {
            "run_id": "robot-full-test",
            "ok": False,
            "checks": {"success_marker": False},
        },
    )

    report = finalize_nebius_full_training_run(run)

    assert report["ok"] is False
    assert report["monitor_state"] == "running"
    assert report["missing_gates"] == ["success_marker", "artifact_inventory"]
    assert (run / "finalization_report.json").is_file()
    assert (run / "finalization_summary.md").is_file()


def test_finalize_accepts_complete_monitor_and_validation(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(
        run / "monitor_status.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "state": "complete",
            "summary": {
                "completed_stage_count": 6,
                "total_stage_count": 6,
                "missing_gates": [],
            },
        },
    )
    _write_json(
        run / "validation_report.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "checks": {"success_marker": True, "backend_comparison": True},
        },
    )
    _write_json(run / "artifact_inventory.json", {"ok": True})

    report = finalize_nebius_full_training_run(run)

    assert report["ok"] is True
    assert report["artifact_inventory_ok"] is True
    assert report["missing_gates"] == []
    assert "Result: `complete`" in (run / "finalization_summary.md").read_text()


def test_finalize_cli_returns_two_for_incomplete_run(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "monitor_status.json", {"ok": False, "state": "running"})
    _write_json(run / "validation_report.json", {"ok": False, "checks": {}})

    assert main([str(run)]) == 2


def test_finalize_rejects_missing_artifact_inventory(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(
        run / "monitor_status.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "state": "complete",
            "summary": {"missing_gates": []},
        },
    )
    _write_json(
        run / "validation_report.json",
        {
            "run_id": "robot-full-test",
            "ok": True,
            "checks": {"success_marker": True},
        },
    )
    _write_json(run / "artifact_inventory.json", {"ok": False})

    report = finalize_nebius_full_training_run(run)

    assert report["ok"] is False
    assert report["artifact_inventory_ok"] is False
    assert report["missing_gates"] == ["artifact_inventory"]
