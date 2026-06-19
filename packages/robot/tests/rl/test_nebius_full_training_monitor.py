from __future__ import annotations

import json
from pathlib import Path

from scripts.monitor_nebius_full_training_run import (
    classify_run,
    main,
    monitor_nebius_full_training_run,
    summarize_validation,
)


def test_classify_run_states(tmp_path: Path) -> None:
    run = tmp_path / "run"
    (run / "status").mkdir(parents=True)

    assert classify_run(run, {"ok": False}) == "running"

    (run / "status" / "failure.txt").write_text("FAILED\n")
    assert classify_run(run, {"ok": True}) == "failed"

    (run / "status" / "failure.txt").unlink()
    (run / "status" / "success.txt").write_text("SUCCESS\n")
    assert classify_run(run, {"ok": False}) == "invalid"
    assert classify_run(run, {"ok": True}) == "complete"


def test_monitor_writes_running_status_for_incomplete_synced_tree(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    (run / "logs").mkdir(parents=True)
    (run / "status").mkdir(parents=True)

    status = monitor_nebius_full_training_run(
        run_id="robot-full-test",
        bucket="bucket",
        endpoint="https://example.test",
        dest=run,
        skip_sync=True,
        run_deep_validators=False,
    )

    assert status["ok"] is False
    assert status["state"] == "running"
    assert status["checks"]["success_marker"] is False
    assert status["summary"]["next_action"] == "continue_polling"
    assert "success_marker" in status["summary"]["missing_gates"]
    assert (run / "monitor_status.json").is_file()
    assert (run / "monitor_summary.md").is_file()


def test_monitor_cli_returns_one_for_running_synced_tree(tmp_path: Path) -> None:
    run = tmp_path / "run"
    run.mkdir()

    rc = main(
        [
            "--run-id",
            "robot-full-test",
            "--bucket",
            "bucket",
            "--dest",
            str(run),
            "--skip-sync",
            "--no-deep-validators",
        ]
    )

    assert rc == 1
    loaded = json.loads((run / "monitor_status.json").read_text())
    assert loaded["state"] == "running"
    assert loaded["summary"]["next_action"] == "continue_polling"


def test_summarize_validation_reports_missing_gates_and_next_action() -> None:
    summary = summarize_validation(
        {
            "ok": False,
            "checks": {
                "success_marker": True,
                "failure_marker_absent": True,
                "backend_comparison": False,
            },
            "reports": {
                "stages": {
                    "checks": {
                        "00_local_preflight": True,
                        "20_nebius_compare_backends": False,
                    }
                }
            },
        }
    )

    assert summary["completed_stage_count"] == 1
    assert summary["pending_stages"] == ["20_nebius_compare_backends"]
    assert summary["missing_gates"] == ["backend_comparison"]
    assert summary["next_action"] == "inspect_failed_validation_gates"
