from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    list_runs,
    recover_stale_running_runs,
    repair_nonzero_returncode_statuses,
    update_run_result,
)


def _create_group(conn) -> None:
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["demo_bench"],
        repo_meta={},
    )


def _insert_running(conn, *, run_id: str, started_at: str) -> None:
    insert_run_start(
        conn,
        run_id=run_id,
        run_group_id="rg_test",
        benchmark_id="demo_bench",
        benchmark_directory="demo_bench",
        signature=f"sig-{run_id}",
        attempt=1,
        agent="eliza",
        provider="test",
        model="test-model",
        extra_config={},
        started_at=started_at,
        command=[],
        cwd=".",
        stdout_path="",
        stderr_path="",
        benchmark_version=None,
        benchmarks_commit=None,
        eliza_commit=None,
        eliza_version=None,
    )


def test_repair_nonzero_returncode_statuses_marks_legacy_success_failed(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    _create_group(conn)
    _insert_running(conn, run_id="run_nonzero", started_at="2026-05-12T00:00:00+00:00")
    update_run_result(
        conn,
        run_id="run_nonzero",
        status="succeeded",
        ended_at="2026-05-12T00:01:00+00:00",
        duration_seconds=60,
        score=0.75,
        unit="ratio",
        higher_is_better=True,
        metrics={"return_code": 2},
        result_json_path="/tmp/result.json",
        artifacts=[],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
    )

    repaired = repair_nonzero_returncode_statuses(conn)
    row = list_runs(conn, limit=None)[0]

    assert repaired == 1
    assert row["status"] == "failed"
    assert row["score"] == 0.75
    assert row["metrics"]["return_code"] == 2
    assert "return code 2" in row["error"]


def test_recover_stale_running_runs_marks_only_stale_runs_failed(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    _create_group(conn)
    _insert_running(conn, run_id="run_stale", started_at="2026-05-12T00:00:00+00:00")
    _insert_running(conn, run_id="run_fresh", started_at="2026-05-12T00:10:00+00:00")

    recovered = recover_stale_running_runs(
        conn,
        stale_before="2026-05-12T00:05:00+00:00",
        ended_at="2026-05-12T00:15:00+00:00",
    )
    rows = {row["run_id"]: row for row in list_runs(conn, limit=None)}
    group = conn.execute(
        "SELECT finished_at FROM run_groups WHERE run_group_id = ?",
        ("rg_test",),
    ).fetchone()

    assert recovered == ["run_stale"]
    assert rows["run_stale"]["status"] == "failed"
    assert rows["run_stale"]["duration_seconds"] == 900
    assert rows["run_stale"]["metrics"] == {"reason": "orchestrator_interrupted"}
    assert rows["run_stale"]["result_json_path"] is None
    assert rows["run_fresh"]["status"] == "running"
    assert group["finished_at"] is None


def test_recover_stale_running_runs_finishes_group_when_none_left(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    _create_group(conn)
    _insert_running(conn, run_id="run_stale", started_at="2026-05-12T00:00:00+00:00")

    recover_stale_running_runs(
        conn,
        stale_before="2026-05-12T00:05:00+00:00",
        ended_at="2026-05-12T00:15:00+00:00",
    )
    group = conn.execute(
        "SELECT finished_at FROM run_groups WHERE run_group_id = ?",
        ("rg_test",),
    ).fetchone()
    metrics = conn.execute(
        "SELECT metrics_json FROM benchmark_runs WHERE run_id = ?",
        ("run_stale",),
    ).fetchone()

    assert group["finished_at"] == "2026-05-12T00:15:00+00:00"
    assert json.loads(metrics["metrics_json"]) == {"reason": "orchestrator_interrupted"}
