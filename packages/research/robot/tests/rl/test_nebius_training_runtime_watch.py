from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from scripts.watch_nebius_training_runtime import watch_nebius_training_runtime


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def test_runtime_watch_recommends_continue_before_stale_threshold(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "running", "ok": False})
    _write_json(
        run / "monitor_status.json",
        {"stage_checks": {"00_local_preflight": True, "10_nebius_train_alberta": False}},
    )

    report = watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 2, 0, tzinfo=UTC),
        hard_cap_hours=12,
        stale_after_hours=6,
    )

    assert report["ok"] is True
    assert report["recommendation"] == "continue_polling"
    assert report["stale"] is False
    assert (run / "runtime_watch.json").is_file()
    assert (run / "runtime_watch.md").is_file()
    history = run / "runtime_watch_history.jsonl"
    assert history.is_file()
    assert len(history.read_text().splitlines()) == 1


def test_runtime_watch_detects_stale_single_stage_run(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "running", "ok": False})
    _write_json(
        run / "monitor_status.json",
        {"stage_checks": {"00_local_preflight": True, "10_nebius_train_alberta": False}},
    )

    report = watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 7, 0, tzinfo=UTC),
        hard_cap_hours=12,
        stale_after_hours=6,
    )

    assert report["ok"] is True
    assert report["stale"] is True
    assert report["recommendation"] == "inspect_runtime_staleness"


def test_runtime_watch_appends_history_without_duplicate_timestamps(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "running", "ok": False})
    _write_json(run / "monitor_status.json", {"stage_checks": {"00_local_preflight": True}})

    watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 2, 0, tzinfo=UTC),
    )
    watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 2, 0, tzinfo=UTC),
    )
    watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 3, 0, tzinfo=UTC),
    )

    lines = (run / "runtime_watch_history.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert "continue_polling" in lines[0]


def test_runtime_watch_detects_hard_cap_exceeded(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "running", "ok": False})

    report = watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 13, 0, tzinfo=UTC),
        hard_cap_hours=12,
        stale_after_hours=6,
    )

    assert report["ok"] is False
    assert report["hard_cap_exceeded"] is True
    assert report["recommendation"] == "inspect_or_terminate_cost_cap_exceeded"


def test_runtime_watch_recommends_failure_inspection_for_failed_closeout(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "failed", "ok": False})

    report = watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 2, 0, tzinfo=UTC),
    )

    assert report["ok"] is True
    assert report["recommendation"] == "inspect_failure_log"


def test_runtime_watch_recommends_gate_inspection_for_invalid_closeout(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"state": "invalid", "ok": False})

    report = watch_nebius_training_runtime(
        run,
        instance_created_at="2026-05-23T00:00:00Z",
        now=datetime(2026, 5, 23, 2, 0, tzinfo=UTC),
    )

    assert report["ok"] is True
    assert report["recommendation"] == "inspect_failed_validation_gates"
