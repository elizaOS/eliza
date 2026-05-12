from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    update_run_result,
)
from benchmarks.orchestrator.runner import _rebuild_latest_result_snapshots
from benchmarks.orchestrator.types import BenchmarkAdapter, ExecutionContext, ScoreSummary


def _adapter(benchmark_id: str) -> BenchmarkAdapter:
    def command_builder(_ctx: ExecutionContext, _adapter: BenchmarkAdapter) -> list[str]:
        return []

    def result_locator(
        _ctx: ExecutionContext,
        _adapter: BenchmarkAdapter,
        _output_root: Path,
    ) -> Path | None:
        return None

    def score_extractor(_path: Path) -> ScoreSummary:
        return ScoreSummary(score=None, unit=None, higher_is_better=True, metrics={})

    return BenchmarkAdapter(
        id=benchmark_id,
        directory=benchmark_id,
        description="test adapter",
        cwd=".",
        command_builder=command_builder,
        result_locator=result_locator,
        score_extractor=score_extractor,
        agent_compatibility=("eliza", "hermes", "openclaw"),
    )


def _seed_run(
    conn,
    *,
    benchmark_id: str,
    agent: str,
    run_id: str,
    started_at: str,
    status: str = "succeeded",
    score: float | None = 1.0,
    metrics: dict[str, Any] | None = None,
    token_metrics: dict[str, Any] | None = None,
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
        metrics=metrics or {"n": 2},
        result_json_path=None,
        artifacts=[],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
        token_metrics=token_metrics or {"total_tokens": 12, "llm_call_count": 2},
    )


def test_rebuild_latest_preserves_existing_snapshots_when_db_has_no_rows(
    tmp_path: Path,
    capsys,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)

    existing_files = {
        tmp_path / "latest" / "bfcl__eliza.json": {"kind": "latest"},
        tmp_path / "latest" / "index.json": {"latest": {"bfcl::eliza": {}}},
        tmp_path / "quarantine" / "bfcl__hermes.json": {"kind": "quarantine"},
        tmp_path / "baselines" / "bfcl__perfect_v1.json": {"kind": "baseline"},
    }
    for path, payload in existing_files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})

    captured = capsys.readouterr()
    assert "database has no benchmark_runs rows" in captured.err
    for path, payload in existing_files.items():
        assert json.loads(path.read_text(encoding="utf-8")) == payload


def test_rebuild_latest_prunes_stale_managed_snapshots_when_db_has_rows(
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
        run_id="run_eliza",
        started_at="2026-05-12T00:00:00+00:00",
    )

    stale_paths = [
        tmp_path / "latest" / "stale__eliza.json",
        tmp_path / "quarantine" / "stale__hermes.json",
        tmp_path / "baselines" / "stale__perfect_v1.json",
    ]
    for path in stale_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})

    assert (tmp_path / "latest" / "bfcl__eliza.json").exists()
    for path in stale_paths:
        assert not path.exists()


def test_rebuild_latest_routes_synthetic_to_baselines_and_prunes_stale_latest(
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
        run_id="run_eliza",
        started_at="2026-05-12T00:00:00+00:00",
    )
    _seed_run(
        conn,
        benchmark_id="bfcl",
        agent="perfect_v1",
        run_id="run_perfect",
        started_at="2026-05-12T00:02:00+00:00",
        metrics={"synthetic_harness": "perfect_v1"},
        token_metrics={},
    )

    stale_latest = tmp_path / "latest" / "bfcl__perfect_v1.json"
    stale_latest.parent.mkdir(parents=True)
    stale_latest.write_text("{}", encoding="utf-8")

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})

    latest = tmp_path / "latest" / "bfcl__eliza.json"
    baseline = tmp_path / "baselines" / "bfcl__perfect_v1.json"
    assert latest.exists()
    assert baseline.exists()
    assert not stale_latest.exists()
    assert json.loads(baseline.read_text(encoding="utf-8"))["synthetic"] is True
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert set(index["latest"]) == {"bfcl::eliza"}


def test_rebuild_latest_quarantines_estimated_token_rows(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["action-calling"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="action-calling",
        agent="eliza",
        run_id="run_estimated",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={"n": 25},
        token_metrics={
            "total_tokens": 1024,
            "llm_call_count": 25,
            "estimated_prompt_tokens": 1024,
            "token_estimate_source": "prompt_chars_div_4",
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"action-calling": _adapter("action-calling")},
    )

    latest = tmp_path / "latest" / "action-calling__eliza.json"
    quarantine = tmp_path / "quarantine" / "action-calling__eliza.json"
    assert not latest.exists()
    payload = json.loads(quarantine.read_text(encoding="utf-8"))
    assert payload["quarantine_reason"] == "estimated_token_metrics:prompt_chars_div_4"
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert index["latest"] == {}


def test_rebuild_latest_ignores_newer_running_rows(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["adhdbench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="adhdbench",
        agent="eliza",
        run_id="run_complete",
        started_at="2026-05-12T00:00:00+00:00",
    )
    insert_run_start(
        conn,
        run_id="run_newer_still_running",
        run_group_id="rg_test",
        benchmark_id="adhdbench",
        benchmark_directory="adhdbench",
        signature="sig-running",
        attempt=1,
        agent="eliza",
        provider="test",
        model="test-model",
        extra_config={},
        started_at="2026-05-12T00:10:00+00:00",
        command=[],
        cwd=".",
        stdout_path="",
        stderr_path="",
        benchmark_version=None,
        benchmarks_commit=None,
        eliza_commit=None,
        eliza_version=None,
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"adhdbench": _adapter("adhdbench")},
    )

    payload = json.loads(
        (tmp_path / "latest" / "adhdbench__eliza.json").read_text(encoding="utf-8")
    )
    assert payload["run_id"] == "run_complete"
    assert payload["status"] == "succeeded"


def test_rebuild_latest_skips_stale_compatibility_incompatible_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
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
        agent="openclaw",
        run_id="run_success",
        started_at="2026-05-12T00:00:00+00:00",
    )
    _seed_run(
        conn,
        benchmark_id="loca_bench",
        agent="openclaw",
        run_id="run_old_incompat",
        started_at="2026-05-12T00:10:00+00:00",
        status="incompatible",
        score=None,
        metrics={
            "reason": "harness_not_in_compatibility",
            "harness": "openclaw",
            "supported_harnesses": ["eliza", "hermes"],
        },
        token_metrics={},
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"loca_bench": _adapter("loca_bench")},
    )

    payload = json.loads(
        (tmp_path / "latest" / "loca_bench__openclaw.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["run_id"] == "run_success"
    assert payload["status"] == "succeeded"
