"""Covers SQLite lifecycle guarantees for stale-run recovery and resume-time
row retirement against the real database layer (no mocks)."""

from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    finish_run_group,
    initialize_database,
    insert_run_start,
    list_run_groups,
    list_runs,
    pause_running_runs_in_group,
    recover_stale_running_runs,
    update_run_result,
)


FAR_FUTURE = "2100-01-01T00:00:00+00:00"


def _connect(tmp_path: Path):
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    return conn


def _seed_group(
    conn,
    group_id: str,
    *,
    namespace: str | None = None,
    finished_at: str | None = None,
) -> None:
    create_run_group(
        conn,
        run_group_id=group_id,
        created_at="2026-07-01T00:00:00+00:00",
        request={},
        benchmarks=["alpha"],
        repo_meta={},
        execution_namespace=namespace,
        execution_contract={"schema_version": 1} if namespace else None,
        checkpoint_relpath=(
            f".subscription-checkpoints/{group_id}/responses.jsonl"
            if namespace
            else None
        ),
    )
    if finished_at is not None:
        finish_run_group(conn, run_group_id=group_id, finished_at=finished_at)


def _seed_running_row(
    conn,
    run_id: str,
    group_id: str,
    *,
    started_at: str = "2026-07-01T00:00:00+00:00",
) -> None:
    insert_run_start(
        conn,
        run_id=run_id,
        run_group_id=group_id,
        benchmark_id="alpha",
        benchmark_directory="alpha",
        signature=f"sig-{run_id}",
        attempt=1,
        agent="eliza",
        provider="test-provider",
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


def _rows_by_id(conn) -> dict[str, dict]:
    return {row["run_id"]: row for row in list_runs(conn, limit=None)}


def _groups_by_id(conn) -> dict[str, dict]:
    return {group["run_group_id"]: group for group in list_run_groups(conn)}


def test_recover_stale_never_touches_rows_in_finished_groups(
    tmp_path: Path,
) -> None:
    conn = _connect(tmp_path)
    _seed_group(
        conn,
        "rg-sub-finished",
        namespace="benchmark-phase-v1-finished",
        finished_at="2026-07-02T00:00:00+00:00",
    )
    _seed_group(conn, "rg-plain-finished", finished_at="2026-07-02T00:00:00+00:00")
    _seed_running_row(conn, "run-sub-zombie", "rg-sub-finished")
    _seed_running_row(conn, "run-plain-zombie", "rg-plain-finished")

    recovered = recover_stale_running_runs(
        conn,
        stale_before=FAR_FUTURE,
        ended_at="2026-07-03T00:00:00+00:00",
    )

    assert recovered == []
    rows = _rows_by_id(conn)
    assert rows["run-sub-zombie"]["status"] == "running"
    assert rows["run-plain-zombie"]["status"] == "running"
    groups = _groups_by_id(conn)
    for group_id in ("rg-sub-finished", "rg-plain-finished"):
        assert groups[group_id]["finished_at"] == "2026-07-02T00:00:00+00:00"
        assert groups[group_id]["cohort_status"] == "succeeded"
    conn.close()


def test_recover_stale_still_pauses_unfinished_namespaced_groups(
    tmp_path: Path,
) -> None:
    conn = _connect(tmp_path)
    _seed_group(conn, "rg-sub-open", namespace="benchmark-phase-v1-open")
    _seed_running_row(conn, "run-sub-stale", "rg-sub-open")

    recovered = recover_stale_running_runs(
        conn,
        stale_before=FAR_FUTURE,
        ended_at="2026-07-03T00:00:00+00:00",
    )

    assert recovered == ["run-sub-stale"]
    row = _rows_by_id(conn)["run-sub-stale"]
    assert row["status"] == "paused_unknown"
    assert row["ended_at"] == "2026-07-03T00:00:00+00:00"
    group = _groups_by_id(conn)["rg-sub-open"]
    assert group["cohort_status"] == "paused_unknown"
    assert group["pause_reason"] == "orchestrator_interrupted"
    assert group["finished_at"] is None
    conn.close()


def test_recover_stale_namespaceless_scope_leaves_namespaced_groups_alone(
    tmp_path: Path,
) -> None:
    conn = _connect(tmp_path)
    _seed_group(conn, "rg-plain-open")
    _seed_group(conn, "rg-sub-open", namespace="benchmark-phase-v1-open")
    _seed_running_row(conn, "run-plain-stale", "rg-plain-open")
    _seed_running_row(conn, "run-sub-stale", "rg-sub-open")

    recovered = recover_stale_running_runs(
        conn,
        stale_before=FAR_FUTURE,
        ended_at="2026-07-03T00:00:00+00:00",
        include_namespaced_groups=False,
    )

    assert recovered == ["run-plain-stale"]
    rows = _rows_by_id(conn)
    assert rows["run-plain-stale"]["status"] == "failed"
    assert rows["run-sub-stale"]["status"] == "running"
    groups = _groups_by_id(conn)
    assert groups["rg-plain-open"]["cohort_status"] == "failed"
    assert groups["rg-plain-open"]["finished_at"] is not None
    assert groups["rg-sub-open"]["cohort_status"] == "running"
    assert groups["rg-sub-open"]["finished_at"] is None
    conn.close()


def test_pause_running_runs_in_group_retires_entire_killed_attempt(
    tmp_path: Path,
) -> None:
    conn = _connect(tmp_path)
    _seed_group(conn, "rg-resuming", namespace="benchmark-phase-v1-resuming")
    _seed_group(conn, "rg-other", namespace="benchmark-phase-v1-other")
    _seed_running_row(conn, "run-zombie", "rg-resuming")
    _seed_running_row(conn, "run-done", "rg-resuming")
    _seed_running_row(conn, "run-broken", "rg-resuming")
    _seed_running_row(conn, "run-other-live", "rg-other")
    update_run_result(
        conn,
        run_id="run-done",
        status="succeeded",
        ended_at="2026-07-01T01:00:00+00:00",
        duration_seconds=3600.0,
        score=1.0,
        unit="ratio",
        higher_is_better=True,
        metrics={},
        result_json_path=None,
        artifacts=[],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
    )
    update_run_result(
        conn,
        run_id="run-broken",
        status="failed",
        ended_at="2026-07-01T02:00:00+00:00",
        duration_seconds=1800.0,
        score=None,
        unit=None,
        higher_is_better=None,
        metrics={},
        result_json_path=None,
        artifacts=[],
        error="harness crashed",
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
    )

    retired = pause_running_runs_in_group(
        conn,
        run_group_id="rg-resuming",
        ended_at="2026-07-03T00:00:00+00:00",
        error="Superseded by a resumed cohort attempt",
    )

    # The resumed attempt reruns every harness with force=True, so the killed
    # attempt's failed/succeeded rows are retired alongside its zombie running
    # rows; a stale 'failed' row left behind would poison the finalization's
    # any-row-failed check even when every rerun succeeds.
    assert retired == 3
    rows = _rows_by_id(conn)
    assert rows["run-zombie"]["status"] == "paused_unknown"
    assert rows["run-zombie"]["ended_at"] == "2026-07-03T00:00:00+00:00"
    assert rows["run-zombie"]["error"] == "Superseded by a resumed cohort attempt"
    assert rows["run-done"]["status"] == "paused_unknown"
    # Completed rows keep their original ended_at; only the status and error
    # record that the resumed attempt superseded them.
    assert rows["run-done"]["ended_at"] == "2026-07-01T01:00:00+00:00"
    assert rows["run-done"]["error"] == "Superseded by a resumed cohort attempt"
    assert rows["run-broken"]["status"] == "paused_unknown"
    assert rows["run-broken"]["ended_at"] == "2026-07-01T02:00:00+00:00"
    assert rows["run-broken"]["error"] == "Superseded by a resumed cohort attempt"
    assert rows["run-other-live"]["status"] == "running"
    conn.close()
