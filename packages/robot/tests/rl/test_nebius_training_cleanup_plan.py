from __future__ import annotations

import json
from pathlib import Path

from scripts.plan_nebius_training_cleanup import main, plan_nebius_training_cleanup


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def test_cleanup_plan_blocks_until_closeout_complete(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(run / "finalization_report.json", {"ok": False})
    _write_json(run / "artifact_inventory.json", {"ok": False})
    _write_json(run / "validation_report.json", {"ok": False})
    _write_json(run / "training_comparison_report.json", {"ok": False})

    report = plan_nebius_training_cleanup(
        run,
        instance_id="instance-1",
        disk_id="disk-1",
        upload_access_key_id="key-1",
    )

    assert report["ok"] is False
    assert report["complete"] is False
    assert report["override_used"] is False
    assert report["commands"] == []
    assert len(report["held_commands_until_complete"]) == 4
    assert "artifact_inventory.ok is not true" in report["blockers"]
    assert "validation_report.ok is not true" in report["blockers"]
    assert "training_comparison_report.ok is not true" in report["blockers"]
    assert (run / "cleanup_plan.json").is_file()
    assert "held until closeout" in (run / "cleanup_plan.md").read_text()


def test_cleanup_plan_emits_commands_after_complete_closeout(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": True, "state": "complete"})
    _write_json(run / "finalization_report.json", {"ok": True})
    _write_json(run / "artifact_inventory.json", {"ok": True})
    _write_json(run / "validation_report.json", {"ok": True})
    _write_json(run / "training_comparison_report.json", {"ok": True})

    report = plan_nebius_training_cleanup(
        run,
        instance_id="instance-1",
        disk_id="disk-1",
        upload_access_key_id="key-1",
    )

    assert report["ok"] is True
    assert report["complete"] is True
    assert report["override_used"] is False
    assert [item["name"] for item in report["commands"]] == [
        "delete_upload_access_key",
        "stop_instance",
        "delete_instance",
        "confirm_disk_deleted_or_delete_if_unmanaged",
    ]


def test_cleanup_plan_blocks_when_inventory_incomplete(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": True, "state": "complete"})
    _write_json(run / "finalization_report.json", {"ok": True})
    _write_json(run / "artifact_inventory.json", {"ok": False})
    _write_json(run / "validation_report.json", {"ok": True})
    _write_json(run / "training_comparison_report.json", {"ok": True})

    report = plan_nebius_training_cleanup(run, instance_id="instance-1")

    assert report["ok"] is False
    assert report["commands"] == []
    assert report["artifact_inventory_ok"] is False
    assert report["blockers"] == ["artifact_inventory.ok is not true"]


def test_cleanup_plan_blocks_when_validation_or_training_report_incomplete(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": True, "state": "complete"})
    _write_json(run / "finalization_report.json", {"ok": True})
    _write_json(run / "artifact_inventory.json", {"ok": True})
    _write_json(run / "validation_report.json", {"ok": False})
    _write_json(run / "training_comparison_report.json", {"ok": False})

    report = plan_nebius_training_cleanup(run, instance_id="instance-1")

    assert report["ok"] is False
    assert report["commands"] == []
    assert report["validation_ok"] is False
    assert report["training_report_ok"] is False
    assert report["blockers"] == [
        "validation_report.ok is not true",
        "training_comparison_report.ok is not true",
    ]


def test_cleanup_plan_marks_override_when_forced_before_complete(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": True, "state": "running"})
    _write_json(run / "finalization_report.json", {"ok": True})
    _write_json(run / "artifact_inventory.json", {"ok": False})
    _write_json(run / "validation_report.json", {"ok": True})
    _write_json(run / "training_comparison_report.json", {"ok": True})

    report = plan_nebius_training_cleanup(
        run,
        instance_id="instance-1",
        allow_before_complete=True,
    )

    assert report["ok"] is True
    assert report["complete"] is False
    assert report["override_used"] is True
    assert report["blockers"] == ["artifact_inventory.ok is not true"]
    assert [item["name"] for item in report["commands"]] == [
        "stop_instance",
        "delete_instance",
    ]
    assert "Override" in (run / "cleanup_plan.md").read_text()


def test_cleanup_plan_cli_returns_two_when_blocked(tmp_path: Path) -> None:
    run = tmp_path / "run"
    run.mkdir()

    rc = main([str(run), "--instance-id", "instance-1"])

    assert rc == 2
    assert (run / "cleanup_plan.json").is_file()
