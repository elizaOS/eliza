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
    score: float | None,
    status: str = "succeeded",
    extra_config: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
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
        status=status,
        ended_at=started_at,
        duration_seconds=1.0,
        score=score,
        unit="ratio" if score is not None else None,
        higher_is_better=True if score is not None else None,
        metrics=metrics or {"score": score},
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


def test_calibration_report_labels_direct_score_calibration_as_weak(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["mmau"],
        repo_meta={},
    )
    for idx, (agent, score) in enumerate(
        (
            ("perfect_v1", 1.0),
            ("wrong_v1", 0.0),
            ("half_v1", 0.5),
        ),
        start=1,
    ):
        _seed_run(
            conn,
            benchmark_id="mmau",
            agent=agent,
            run_id=f"run_{agent}",
            started_at=f"2026-05-12T00:0{idx}:00+00:00",
            score=score,
            metrics={"calibration_depth": "direct_score"},
        )
    conn.close()

    report = build_calibration_report(workspace_root=tmp_path, benchmark_ids={"mmau"})

    assert report["rows"][0]["calibration_status"] == "valid_direct_score"


def test_calibration_report_labels_scorer_payload_calibration_as_valid(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["mmau"],
        repo_meta={},
    )
    for idx, (agent, score) in enumerate(
        (
            ("perfect_v1", 1.0),
            ("wrong_v1", 0.0),
            ("half_v1", 0.5),
        ),
        start=1,
    ):
        _seed_run(
            conn,
            benchmark_id="mmau",
            agent=agent,
            run_id=f"run_{agent}",
            started_at=f"2026-05-12T00:0{idx}:00+00:00",
            score=score,
            metrics={"calibration_depth": "scorer_payload"},
        )
    conn.close()

    report = build_calibration_report(workspace_root=tmp_path, benchmark_ids={"mmau"})

    assert report["rows"][0]["calibration_status"] == "valid"


def test_calibration_report_detects_all_right_all_wrong_and_half_right(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["all_right", "all_wrong", "half_right"],
        repo_meta={},
    )
    cases = {
        "all_right": 1.0,
        "all_wrong": 0.0,
        "half_right": 0.5,
    }
    for benchmark_id, score in cases.items():
        for idx, agent in enumerate(("perfect_v1", "wrong_v1", "half_v1"), start=1):
            _seed_run(
                conn,
                benchmark_id=benchmark_id,
                agent=agent,
                run_id=f"run_{benchmark_id}_{agent}",
                started_at=f"2026-05-12T00:0{idx}:00+00:00",
                score=score,
                metrics={"calibration_depth": "scorer_payload"},
            )
    conn.close()

    report = build_calibration_report(
        workspace_root=tmp_path,
        benchmark_ids=set(cases),
    )
    statuses = {
        row["benchmark_id"]: row["calibration_status"]
        for row in report["rows"]
    }

    assert statuses == {
        "all_right": "all_right",
        "all_wrong": "all_wrong",
        "half_right": "half_right",
    }
    assert report["summary"]["all_right"] == 1
    assert report["summary"]["all_wrong"] == 1
    assert report["summary"]["half_right"] == 1


def test_calibration_report_treats_static_incompatibility_as_unsupported(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["loca_bench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="loca_bench",
        agent="eliza",
        run_id="run_eliza",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.75,
    )
    _seed_run(
        conn,
        benchmark_id="loca_bench",
        agent="hermes",
        run_id="run_hermes",
        started_at="2026-05-12T00:01:00+00:00",
        score=0.75,
    )
    conn.close()

    report = build_calibration_report(
        workspace_root=tmp_path,
        benchmark_ids={"loca_bench"},
        agent_compatibility={"loca_bench": ("eliza", "hermes")},
    )
    row = report["rows"][0]

    assert row["real_statuses"]["openclaw"] == "unsupported"
    assert row["missing_required_real_harnesses"] == []
    assert row["failed_required_real_harnesses"] == []
    assert row["real_pattern"] == "all_real_equal"
    assert report["matrix_summary"]["required_real_cells"] == 2
    assert report["matrix_summary"]["unsupported_real_cells"] == 1
    assert report["matrix_summary"]["complete_benchmarks"] == 1


def test_calibration_report_ignores_stale_now_supported_incompatible_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["demo_bench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="demo_bench",
        agent="eliza",
        run_id="run_eliza_success",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.75,
    )
    _seed_run(
        conn,
        benchmark_id="demo_bench",
        agent="eliza",
        run_id="run_eliza_stale_incompatible",
        started_at="2026-05-12T00:01:00+00:00",
        status="incompatible",
        score=None,
        metrics={"reason": "harness_not_in_compatibility"},
    )
    conn.close()

    report = build_calibration_report(
        workspace_root=tmp_path,
        benchmark_ids={"demo_bench"},
        agent_compatibility={"demo_bench": ("eliza",)},
    )
    row = report["rows"][0]

    assert row["real_cells"]["eliza"]["state"] == "succeeded"
    assert row["real_scores"]["eliza"] == 0.75
    assert row["failed_required_real_harnesses"] == []
    assert report["matrix_summary"]["failed_required_real_cells"] == 0


def test_calibration_report_keeps_latest_success_when_newer_attempt_failed(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["demo_bench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="demo_bench",
        agent="eliza",
        run_id="run_eliza_success",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.75,
    )
    _seed_run(
        conn,
        benchmark_id="demo_bench",
        agent="eliza",
        run_id="run_eliza_failed",
        started_at="2026-05-12T00:01:00+00:00",
        status="failed",
        score=None,
        metrics={"reason": "subprocess_failed"},
    )
    conn.close()

    report = build_calibration_report(
        workspace_root=tmp_path,
        benchmark_ids={"demo_bench"},
        agent_compatibility={"demo_bench": ("eliza",)},
    )
    row = report["rows"][0]

    assert row["real_cells"]["eliza"]["state"] == "succeeded"
    assert row["real_cells"]["eliza"]["run_id"] == "run_eliza_success"
    assert row["failed_required_real_harnesses"] == []
    assert report["matrix_summary"]["failed_required_real_cells"] == 0
