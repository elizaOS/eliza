from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    update_run_result,
)
from benchmarks.orchestrator.viewer_data import build_viewer_dataset


def _seed_run(
    conn,
    *,
    benchmark_id: str,
    agent: str,
    run_id: str,
    started_at: str,
    status: str = "succeeded",
    score: float | None = 1.0,
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
    update_run_result(
        conn,
        run_id=run_id,
        status=status,
        ended_at=started_at,
        duration_seconds=1.0,
        score=score,
        unit="ratio" if score is not None else None,
        higher_is_better=True if score is not None else None,
        metrics={"n": 2},
        result_json_path=None,
        artifacts=[],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
    )


def test_viewer_dataset_uses_stable_generation_time_and_terminal_latest(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["bfcl"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="bfcl",
        agent="eliza",
        run_id="run_success",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.75,
    )
    _seed_run(
        conn,
        benchmark_id="bfcl",
        agent="eliza",
        run_id="run_running_newer",
        started_at="2026-05-12T00:01:00+00:00",
        status="running",
        score=None,
    )

    first = build_viewer_dataset(conn)
    second = build_viewer_dataset(conn)
    summary = first["benchmark_summary"][0]

    assert first["generated_at"] == second["generated_at"]
    assert summary["latest_run_id"] == "run_success"
    assert first["latest_scores"][0]["run_id"] == "run_success"


def test_viewer_calibration_summary_uses_terminal_latest(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["bfcl"],
        repo_meta={},
    )
    for agent, score in (
        ("perfect_v1", 1.0),
        ("wrong_v1", 0.0),
        ("half_v1", 0.5),
    ):
        _seed_run(
            conn,
            benchmark_id="bfcl",
            agent=agent,
            run_id=f"run_{agent}",
            started_at="2026-05-12T00:00:00+00:00",
            score=score,
        )
    _seed_run(
        conn,
        benchmark_id="bfcl",
        agent="perfect_v1",
        run_id="run_perfect_running_newer",
        started_at="2026-05-12T00:01:00+00:00",
        status="running",
        score=None,
    )

    data = build_viewer_dataset(conn)
    calibration = data["calibration_summary"][0]

    assert calibration["complete"] is True
    assert calibration["statuses"]["perfect_v1"] == "succeeded"
    assert calibration["scores"]["perfect_v1"] == 1.0


def test_viewer_dataset_filters_retired_benchmark_ids(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["hyperliquidbench", "hyperliquid_bench"],
        repo_meta={},
    )
    create_run_group(
        conn,
        run_group_id="rg_legacy_only",
        created_at="2026-05-12T00:02:00+00:00",
        request={},
        benchmarks=["hyperliquidbench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="hyperliquidbench",
        agent="eliza",
        run_id="run_legacy_alias",
        started_at="2026-05-12T00:00:00+00:00",
    )
    _seed_run(
        conn,
        benchmark_id="hyperliquid_bench",
        agent="eliza",
        run_id="run_canonical",
        started_at="2026-05-12T00:01:00+00:00",
    )

    data = build_viewer_dataset(conn, benchmark_ids={"hyperliquid_bench"})

    assert {row["benchmark_id"] for row in data["runs"]} == {"hyperliquid_bench"}
    assert {row["benchmark_id"] for row in data["latest_scores"]} == {
        "hyperliquid_bench"
    }
    assert {row["benchmark_id"] for row in data["benchmark_summary"]} == {
        "hyperliquid_bench"
    }
    assert [group["run_group_id"] for group in data["run_groups"]] == ["rg_test"]
    assert data["run_groups"][0]["benchmarks"] == ["hyperliquid_bench"]
    assert data["generated_at"] == "2026-05-12T00:01:00+00:00"
