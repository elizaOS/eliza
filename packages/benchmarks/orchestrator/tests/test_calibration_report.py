from __future__ import annotations

from pathlib import Path
from typing import Any

from benchmarks.orchestrator.calibration_report import build_calibration_report
from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    update_run_result,
)


def _seed_run(
    conn,
    *,
    benchmark_id: str,
    agent: str,
    run_id: str,
    started_at: str,
    score: float,
    extra_config: dict[str, Any] | None = None,
) -> None:
    insert_run_start(
        conn,
        run_id=run_id,
        run_group_id="rg_test",
        benchmark_id=benchmark_id,
        benchmark_directory=benchmark_id,
        signature=f"sig-{run_id}",
        attempt=1,
        agent=agent,
        provider="test",
        model="test-model",
        extra_config=extra_config or {},
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
    update_run_result(
        conn,
        run_id=run_id,
        status="succeeded",
        ended_at=started_at,
        duration_seconds=1.0,
        score=score,
        unit="ratio",
        higher_is_better=True,
        metrics={"score": score},
        result_json_path=None,
        artifacts=[],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
    )


def test_calibration_report_flags_mixed_real_comparison_configs(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["woobench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="eliza",
        run_id="run_eliza",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.8,
        extra_config={"scenarios": ["friend_supporter_tarot_01"]},
    )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="hermes",
        run_id="run_hermes",
        started_at="2026-05-12T00:01:00+00:00",
        score=0.7,
        extra_config={"scenarios": ["friend_supporter_tarot_01"]},
    )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="openclaw",
        run_id="run_openclaw",
        started_at="2026-05-12T00:02:00+00:00",
        score=0.6,
        extra_config={"scenarios": ["true_believer_tarot_01"]},
    )
    conn.close()

    report = build_calibration_report(workspace_root=tmp_path, benchmark_ids={"woobench"})
    row = report["rows"][0]

    assert row["real_pattern"] == "real_differ_mixed_config"
    assert len(set(row["real_comparison_signatures"].values())) == 2
