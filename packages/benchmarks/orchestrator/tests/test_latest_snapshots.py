from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    recover_stale_running_runs,
    update_run_result,
)
from benchmarks.orchestrator.adapters import (
    GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON,
    VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON,
)
from benchmarks.orchestrator.runner import _rebuild_latest_result_snapshots
from benchmarks.orchestrator.types import BenchmarkAdapter, ExecutionContext, ScoreSummary


def _adapter(
    benchmark_id: str,
    *,
    agent_compatibility: tuple[str, ...] = ("eliza", "hermes", "openclaw"),
) -> BenchmarkAdapter:
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
        agent_compatibility=agent_compatibility,
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
    extra_config: dict[str, Any] | None = None,
    result_json_path: str | None = None,
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
        metrics=metrics or {"n": 2},
        result_json_path=result_json_path,
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


def test_rebuild_latest_preserves_valid_snapshots_missing_from_partial_db(
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

    preserved = tmp_path / "latest" / "webshop__eliza.json"
    preserved.parent.mkdir(parents=True, exist_ok=True)
    preserved.write_text(
        json.dumps(
            {
                "benchmark_id": "webshop",
                "benchmark_directory": "webshop",
                "agent": "eliza",
                "status": "succeeded",
                "score": 1.0,
                "run_id": "run_webshop_old",
                "run_group_id": "rg_old",
                "signature": "sig-webshop-old",
                "comparison_signature": "cmp-webshop-old",
                "updated_at": "2026-05-11T00:00:00+00:00",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"bfcl": _adapter("bfcl"), "webshop": _adapter("webshop", agent_compatibility=("eliza",))},
    )

    assert (tmp_path / "latest" / "bfcl__eliza.json").exists()
    assert preserved.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert set(index["latest"]) == {"bfcl::eliza", "webshop::eliza"}
    assert index["latest"]["webshop::eliza"]["run_id"] == "run_webshop_old"


def test_rebuild_latest_prunes_preserved_snapshot_excluded_by_current_compatibility(
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

    preserved = tmp_path / "latest" / "vision_language__hermes.json"
    preserved.parent.mkdir(parents=True, exist_ok=True)
    preserved.write_text(
        json.dumps(
            {
                "benchmark_id": "vision_language",
                "benchmark_directory": "vision-language",
                "agent": "hermes",
                "status": "succeeded",
                "score": 0.0,
                "run_id": "run_stale_vision_hermes",
                "run_group_id": "rg_old",
                "signature": "sig-vision-hermes-old",
                "comparison_signature": "cmp-vision-hermes-old",
                "updated_at": "2026-05-11T00:00:00+00:00",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "bfcl": _adapter("bfcl"),
            "vision_language": _adapter("vision_language", agent_compatibility=("eliza",)),
        },
    )

    assert not preserved.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert "vision_language::hermes" not in index["latest"]
    assert index["matrix_contract"]["benchmarks"]["vision_language"]["cells"]["hermes"] == {
        "required": False,
        "state": "unsupported",
        "status": "unsupported",
        "score": None,
        "run_id": None,
        "reason": VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON,
    }


def test_rebuild_latest_prunes_mislabeled_hermes_native_env_snapshots(
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

    preserved = tmp_path / "latest" / "hermes_tblite__eliza.json"
    preserved.parent.mkdir(parents=True, exist_ok=True)
    preserved.write_text(
        json.dumps(
            {
                "benchmark_id": "hermes_tblite",
                "benchmark_directory": "hermes-adapter",
                "agent": "eliza",
                "status": "succeeded",
                "score": 0.0,
                "run_id": "run_mislabeled_tblite_eliza",
                "run_group_id": "rg_old",
                "signature": "sig-tblite-eliza-old",
                "comparison_signature": "cmp-tblite-eliza-old",
                "updated_at": "2026-05-11T00:00:00+00:00",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "bfcl": _adapter("bfcl"),
            "hermes_tblite": _adapter("hermes_tblite", agent_compatibility=("hermes",)),
        },
    )

    assert not preserved.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert "hermes_tblite::eliza" not in index["latest"]
    assert index["matrix_contract"]["benchmarks"]["hermes_tblite"]["cells"]["eliza"] == {
        "required": False,
        "state": "unsupported",
        "status": "unsupported",
        "score": None,
        "run_id": None,
        "reason": "harness 'eliza' not in adapter compatibility (hermes)",
    }


def test_rebuild_latest_recomputes_warnings_for_preserved_snapshots(
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

    preserved = tmp_path / "latest" / "hermes_yc_bench__hermes.json"
    preserved.parent.mkdir(parents=True, exist_ok=True)
    preserved.write_text(
        json.dumps(
            {
                "benchmark_id": "hermes_yc_bench",
                "benchmark_directory": "hermes-adapter",
                "agent": "hermes",
                "status": "succeeded",
                "score": 0.56,
                "run_id": "run_preserved_yc",
                "run_group_id": "rg_old",
                "signature": "sig-yc-old",
                "comparison_signature": "cmp-yc-old",
                "updated_at": "2026-05-11T00:00:00+00:00",
                "metrics": {
                    "env_id": "yc_bench",
                    "survival_rate": 1.0,
                    "total_runs": 1,
                },
                "token_metrics": {
                    "total_tokens": 0,
                    "llm_call_count": 1,
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                },
                "publication_warnings": [
                    "telemetry_missing_total_tokens",
                    "single_llm_call",
                ],
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "bfcl": _adapter("bfcl"),
            "hermes_yc_bench": _adapter(
                "hermes_yc_bench",
                agent_compatibility=("hermes",),
            ),
        },
    )

    payload = json.loads(preserved.read_text(encoding="utf-8"))
    assert "publication_warnings" not in payload
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert index["latest"]["hermes_yc_bench::hermes"]["run_id"] == "run_preserved_yc"


def test_rebuild_latest_repairs_zero_sample_hermes_successes(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["humaneval"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="humaneval",
        agent="hermes",
        run_id="run_empty_hermes",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.0,
        metrics={"score": 0.0, "n": 0, "passed": 0},
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"humaneval": _adapter("humaneval")})

    assert not (tmp_path / "latest" / "humaneval__hermes.json").exists()
    quarantine = json.loads(
        (tmp_path / "quarantine" / "humaneval__hermes.json").read_text(
            encoding="utf-8"
        )
    )
    assert quarantine["status"] == "failed"
    assert "zero-sample success artifact" in quarantine["error"]


def test_rebuild_latest_is_byte_stable_when_inputs_do_not_change(
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

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})
    first_index = (tmp_path / "latest" / "index.json").read_text(encoding="utf-8")
    first_snapshot = (tmp_path / "latest" / "bfcl__eliza.json").read_text(encoding="utf-8")

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})

    assert (tmp_path / "latest" / "index.json").read_text(encoding="utf-8") == first_index
    assert (
        (tmp_path / "latest" / "bfcl__eliza.json").read_text(encoding="utf-8")
        == first_snapshot
    )


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
    assert all(
        "perfect_v1" not in key for key in index["latest_by_signature"]
    )
    assert all(
        "perfect_v1" not in key
        for key in index["latest_by_comparison_signature"]
    )


def test_rebuild_latest_publishes_estimated_token_rows_with_warning(
    tmp_path: Path,
) -> None:
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
    assert latest.exists()
    assert not quarantine.exists()
    payload = json.loads(latest.read_text(encoding="utf-8"))
    assert "estimated_token_metrics:prompt_chars_div_4" in payload["publication_warnings"]
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert set(index["latest"]) == {"action-calling::eliza"}


def test_rebuild_latest_quarantines_sample_task_sets(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["webshop"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="webshop",
        agent="eliza",
        run_id="run_sample",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "total_instances": 1,
            "total_samples": 2,
            "total_tasks": 1,
            "total_trials": 1,
            "total_questions": 2,
            "scenario_count": 1,
            "n": 2,
            "sample": True,
        },
        token_metrics={"total_tokens": 200, "llm_call_count": 3},
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"webshop": _adapter("webshop")},
    )

    assert not (tmp_path / "latest" / "webshop__eliza.json").exists()
    payload = json.loads(
        (tmp_path / "quarantine" / "webshop__eliza.json").read_text(encoding="utf-8")
    )
    assert payload["quarantine_reason"] == "sample_task_set"
    assert "sample_task_set" in payload["publication_warnings"]
    assert "insufficient_total_instances:1" in payload["publication_warnings"]
    assert "insufficient_total_samples:2" in payload["publication_warnings"]
    assert "insufficient_total_tasks:1" in payload["publication_warnings"]
    assert "insufficient_total_questions:2" in payload["publication_warnings"]
    assert "insufficient_scenario_count:1" in payload["publication_warnings"]
    assert "insufficient_n:2" in payload["publication_warnings"]


def test_rebuild_latest_quarantines_sample_dataset_sources(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["gaia"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="gaia",
        agent="eliza",
        run_id="run_gaia_sample",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "overall_accuracy": 1.0,
            "total_questions": 2,
            "correct_answers": 2,
            "dataset_source": "sample",
        },
        token_metrics={"total_tokens": 200, "llm_call_count": 3},
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"gaia": _adapter("gaia")})

    assert not (tmp_path / "latest" / "gaia__eliza.json").exists()
    payload = json.loads(
        (tmp_path / "quarantine" / "gaia__eliza.json").read_text(encoding="utf-8")
    )
    assert payload["quarantine_reason"] == "sample_task_set"
    assert "sample_task_set" in payload["publication_warnings"]


def test_rebuild_latest_quarantines_demo_mode_results(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["hyperliquid_bench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="hyperliquid_bench",
        agent="eliza",
        run_id="run_hl_demo",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "final_score": 3.5,
            "total_scenarios": 1,
            "demo_mode": True,
        },
        token_metrics={"total_tokens": 200, "llm_call_count": 3},
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"hyperliquid_bench": _adapter("hyperliquid_bench")},
    )

    assert not (tmp_path / "latest" / "hyperliquid_bench__eliza.json").exists()
    payload = json.loads(
        (tmp_path / "quarantine" / "hyperliquid_bench__eliza.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["quarantine_reason"] == "demo_mode"
    assert "demo_mode" in payload["publication_warnings"]


def test_rebuild_latest_allows_tokenless_deterministic_benchmark_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["framework", "personality_bench", "social_alpha", "solana"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="framework",
        agent="eliza",
        run_id="run_framework",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={"scenario_count": 12},
        token_metrics={
            "total_tokens": None,
            "llm_call_count": 12,
            "prompt_tokens": None,
            "completion_tokens": None,
            "telemetry_missing": True,
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "framework": _adapter("framework", agent_compatibility=("eliza",)),
            "personality_bench": _adapter("personality_bench", agent_compatibility=("eliza",)),
            "social_alpha": _adapter("social_alpha"),
            "solana": _adapter("solana"),
        },
    )

    payload = json.loads(
        (tmp_path / "latest" / "framework__eliza.json").read_text(encoding="utf-8")
    )
    assert "publication_warnings" not in payload

    _seed_run(
        conn,
        benchmark_id="personality_bench",
        agent="eliza",
        run_id="run_personality",
        started_at="2026-05-12T00:01:00+00:00",
        metrics={"total": 87, "agreementRate": 1.0},
        token_metrics={
            "total_tokens": None,
            "llm_call_count": None,
            "prompt_tokens": None,
            "completion_tokens": None,
            "telemetry_missing": True,
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "framework": _adapter("framework", agent_compatibility=("eliza",)),
            "personality_bench": _adapter("personality_bench", agent_compatibility=("eliza",)),
        },
    )

    payload = json.loads(
        (tmp_path / "latest" / "personality_bench__eliza.json").read_text(encoding="utf-8")
    )
    assert "publication_warnings" not in payload

    for benchmark_id in ("social_alpha", "solana"):
        _seed_run(
            conn,
            benchmark_id=benchmark_id,
            agent="eliza",
            run_id=f"run_{benchmark_id}",
            started_at="2026-05-12T00:02:00+00:00",
            metrics={"trajectory_summary": {"turns": 0}},
            token_metrics={
                "total_tokens": None,
                "llm_call_count": None,
                "prompt_tokens": None,
                "completion_tokens": None,
                "telemetry_missing": True,
            },
        )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "framework": _adapter("framework", agent_compatibility=("eliza",)),
            "personality_bench": _adapter("personality_bench", agent_compatibility=("eliza",)),
            "social_alpha": _adapter("social_alpha"),
            "solana": _adapter("solana"),
        },
    )

    for benchmark_id in ("social_alpha", "solana"):
        payload = json.loads(
            (tmp_path / "latest" / f"{benchmark_id}__eliza.json").read_text(
                encoding="utf-8"
            )
        )
        assert "publication_warnings" not in payload


def test_rebuild_latest_allows_tokenless_vision_language_runtime_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["vision_language"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="vision_language",
        agent="eliza",
        run_id="run_vision",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "runtime_id": "eliza-1-9b",
            "tier": "eliza-1-9b",
            "sample_count": 5,
            "error_count": 0,
        },
        token_metrics={
            "total_tokens": 0,
            "llm_call_count": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "telemetry_missing": False,
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"vision_language": _adapter("vision_language", agent_compatibility=("eliza",))},
    )

    payload = json.loads(
        (tmp_path / "latest" / "vision_language__eliza.json").read_text(encoding="utf-8")
    )
    assert "publication_warnings" not in payload


def test_rebuild_latest_allows_tokenless_voiceagentbench_real_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["voiceagentbench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="voiceagentbench",
        agent="openclaw",
        run_id="run_voiceagentbench",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "model_name": "openclaw",
            "stt_provider": "groq",
            "pass_at_1": 1.0,
        },
        token_metrics={
            "total_tokens": 0,
            "llm_call_count": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "telemetry_missing": False,
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"voiceagentbench": _adapter("voiceagentbench", agent_compatibility=("openclaw",))},
    )

    payload = json.loads(
        (tmp_path / "latest" / "voiceagentbench__openclaw.json").read_text(
            encoding="utf-8"
        )
    )
    assert "publication_warnings" not in payload


def test_rebuild_latest_allows_tokenless_hermes_yc_bench_rows(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["hermes_yc_bench"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="hermes_yc_bench",
        agent="hermes",
        run_id="run_yc",
        started_at="2026-05-12T00:00:00+00:00",
        metrics={
            "env_id": "yc_bench",
            "survival_rate": 1.0,
            "avg_composite_score": 0.56,
            "total_runs": 1,
        },
        token_metrics={
            "total_tokens": 0,
            "llm_call_count": 1,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "telemetry_missing": False,
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"hermes_yc_bench": _adapter("hermes_yc_bench", agent_compatibility=("hermes",))},
    )

    payload = json.loads(
        (tmp_path / "latest" / "hermes_yc_bench__hermes.json").read_text(
            encoding="utf-8"
        )
    )
    assert "publication_warnings" not in payload


def test_rebuild_latest_indexes_cross_harness_comparison_signature(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["woobench"],
        repo_meta={},
    )
    for offset, agent in enumerate(("eliza", "hermes", "openclaw")):
        _seed_run(
            conn,
            benchmark_id="woobench",
            agent=agent,
            run_id=f"run_{agent}",
            started_at=f"2026-05-12T00:0{offset}:00+00:00",
            extra_config={
                "agent": agent,
                "harness": agent,
                "scenario": "skeptic_tarot_01",
                **({"openclaw_timeout_s": 60, "reasoning_effort": "low"} if agent == "hermes" else {}),
            },
        )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    comparison_signatures = {
        row["comparison_signature"] for row in index["latest"].values()
    }
    assert len(comparison_signatures) == 1
    comparison_signature = next(iter(comparison_signatures))
    assert set(index["latest_by_comparison_signature"]) == {
        f"{comparison_signature}::woobench::eliza",
        f"{comparison_signature}::woobench::hermes",
        f"{comparison_signature}::woobench::openclaw",
    }
    payload = json.loads(
        (tmp_path / "latest" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    assert payload["extra_config"]["scenario"] == "skeptic_tarot_01"
    assert index["benchmark_comparability"]["woobench"]["comparable"] is True
    assert index["matrix_contract"]["status"] == "complete"
    assert index["matrix_contract"]["summary"]["required_real_cells"] == 3
    assert index["matrix_contract"]["summary"]["succeeded_required_real_cells"] == 3


def test_rebuild_latest_marks_mixed_latest_configs_not_comparable(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["woobench"],
        repo_meta={},
    )
    for offset, (agent, scenario) in enumerate(
        (
            ("eliza", "friend_supporter_tarot_01"),
            ("hermes", "friend_supporter_tarot_01"),
            ("openclaw", "true_believer_tarot_01"),
        )
    ):
        _seed_run(
            conn,
            benchmark_id="woobench",
            agent=agent,
            run_id=f"run_mixed_{agent}",
            started_at=f"2026-05-12T00:0{offset}:00+00:00",
            extra_config={"scenario": scenario},
        )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert index["benchmark_comparability"]["woobench"]["comparable"] is False


def test_rebuild_latest_prefers_newest_complete_comparable_real_cohort(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["woobench"],
        repo_meta={},
    )
    for offset, agent in enumerate(("eliza", "hermes", "openclaw")):
        _seed_run(
            conn,
            benchmark_id="woobench",
            agent=agent,
            run_id=f"run_full_{agent}",
            started_at=f"2026-05-12T00:0{offset}:00+00:00",
            score=0.8,
            extra_config={
                "agent": agent,
                "harness": agent,
                "scenarios": ["friend_supporter_tarot_01", "repeat_customer_tarot_01"],
            },
        )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="eliza",
        run_id="run_newer_eliza_single",
        started_at="2026-05-12T00:03:00+00:00",
        score=0.2,
        extra_config={
            "agent": "eliza",
            "harness": "eliza",
            "scenario": "skeptic_tarot_01",
        },
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    eliza = json.loads(
        (tmp_path / "latest" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert eliza["run_id"] == "run_full_eliza"
    assert index["benchmark_comparability"]["woobench"]["comparable"] is True


def test_rebuild_latest_prefers_within_tolerance_real_cohort(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["lifeops_bench"],
        repo_meta={},
    )
    for offset, agent in enumerate(("eliza", "hermes", "openclaw")):
        _seed_run(
            conn,
            benchmark_id="lifeops_bench",
            agent=agent,
            run_id=f"run_mid_{agent}",
            started_at=f"2026-05-12T00:0{offset}:00+00:00",
            score=0.5,
            extra_config={
                "agent": agent,
                "harness": agent,
                "limit": 2,
                "suite": "smoke",
            },
        )
    _seed_run(
        conn,
        benchmark_id="lifeops_bench",
        agent="openclaw",
        run_id="run_newer_openclaw_high",
        started_at="2026-05-12T00:03:00+00:00",
        score=1.0,
        extra_config={
            "agent": "openclaw",
            "harness": "openclaw",
            "limit": 2,
            "suite": "smoke",
        },
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"lifeops_bench": _adapter("lifeops_bench")},
    )

    openclaw = json.loads(
        (tmp_path / "latest" / "lifeops_bench__openclaw.json").read_text(
            encoding="utf-8"
        )
    )
    assert openclaw["run_id"] == "run_mid_openclaw"


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


def test_recover_stale_running_run_quarantines_without_replacing_latest(
    tmp_path: Path,
) -> None:
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
        run_id="run_success",
        started_at="2026-05-12T00:00:00+00:00",
        score=0.8,
    )
    insert_run_start(
        conn,
        run_id="run_stale",
        run_group_id="rg_test",
        benchmark_id="adhdbench",
        benchmark_directory="adhdbench",
        signature="sig-run-stale",
        attempt=1,
        agent="eliza",
        provider="test",
        model="test-model",
        extra_config={},
        started_at="2026-05-12T00:05:00+00:00",
        command=[],
        cwd=".",
        stdout_path="",
        stderr_path="",
        benchmark_version=None,
        benchmarks_commit=None,
        eliza_commit=None,
        eliza_version=None,
    )

    recovered = recover_stale_running_runs(
        conn,
        stale_before="2026-05-12T00:06:00+00:00",
        ended_at="2026-05-12T00:10:00+00:00",
    )
    _rebuild_latest_result_snapshots(conn, tmp_path, {"adhdbench": _adapter("adhdbench")})

    assert recovered == ["run_stale"]
    latest_payload = json.loads(
        (tmp_path / "latest" / "adhdbench__eliza.json").read_text(encoding="utf-8")
    )
    assert latest_payload["run_id"] == "run_success"
    quarantine_payload = json.loads(
        (tmp_path / "quarantine" / "adhdbench__eliza.json").read_text(encoding="utf-8")
    )
    assert quarantine_payload["run_id"] == "run_stale"
    assert quarantine_payload["status"] == "failed"
    assert quarantine_payload["quarantine_reason"] == "unsucceeded_run"


def test_rebuild_latest_keeps_success_when_newer_failed_row_exists(tmp_path: Path) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
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
        run_id="run_success",
        started_at="2026-05-12T00:00:00+00:00",
        status="succeeded",
        score=0.95,
    )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="eliza",
        run_id="run_failed",
        started_at="2026-05-12T00:10:00+00:00",
        status="failed",
        score=None,
        metrics={"reason": "orchestrator_interrupted"},
        token_metrics={},
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    latest_payload = json.loads(
        (tmp_path / "latest" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    quarantine_payload = json.loads(
        (tmp_path / "quarantine" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    assert latest_payload["run_id"] == "run_success"
    assert latest_payload["status"] == "succeeded"
    assert quarantine_payload["run_id"] == "run_failed"
    assert quarantine_payload["quarantine_reason"] == "unsucceeded_run"


def test_rebuild_latest_preserves_snapshot_when_only_failed_db_row_exists(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
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
        run_id="run_failed",
        started_at="2026-05-12T00:10:00+00:00",
        status="failed",
        score=None,
        metrics={"reason": "orchestrator_interrupted"},
        token_metrics={},
    )
    latest_dir = tmp_path / "latest"
    latest_dir.mkdir(parents=True)
    (latest_dir / "woobench__eliza.json").write_text(
        json.dumps(
            {
                "updated_at": "2026-05-12T00:00:00+00:00",
                "benchmark_id": "woobench",
                "benchmark_directory": "woobench",
                "run_group_id": "rg_old",
                "run_id": "run_preserved",
                "signature": "sig-preserved",
                "comparison_signature": "cmp-preserved",
                "status": "succeeded",
                "agent": "eliza",
                "provider": "test",
                "model": "test-model",
                "score": 0.9,
                "unit": "ratio",
                "higher_is_better": True,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    latest_payload = json.loads(
        (tmp_path / "latest" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    quarantine_payload = json.loads(
        (tmp_path / "quarantine" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))

    assert latest_payload["run_id"] == "run_preserved"
    assert quarantine_payload["run_id"] == "run_failed"
    assert index["latest"]["woobench::eliza"]["run_id"] == "run_preserved"
    assert (
        index["matrix_contract"]["benchmarks"]["woobench"]["cells"]["eliza"]["state"]
        == "succeeded"
    )


def test_rebuild_latest_quarantines_scoreless_success_without_replacing_latest(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
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
        run_id="run_scored_success",
        started_at="2026-05-12T00:00:00+00:00",
        status="succeeded",
        score=0.95,
    )
    _seed_run(
        conn,
        benchmark_id="woobench",
        agent="eliza",
        run_id="run_scoreless_success",
        started_at="2026-05-12T00:10:00+00:00",
        status="succeeded",
        score=None,
        metrics={"reason": "empty_result"},
        token_metrics={},
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    latest_payload = json.loads(
        (tmp_path / "latest" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    quarantine_payload = json.loads(
        (tmp_path / "quarantine" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))

    assert latest_payload["run_id"] == "run_scored_success"
    assert quarantine_payload["run_id"] == "run_scoreless_success"
    assert quarantine_payload["quarantine_reason"] == "missing_score"
    assert index["latest"]["woobench::eliza"]["run_id"] == "run_scored_success"


def test_rebuild_latest_prunes_scoreless_preserved_snapshot_from_partial_db(
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
        run_id="run_bfcl",
        started_at="2026-05-12T00:00:00+00:00",
    )
    fake_latest = tmp_path / "latest" / "webshop__eliza.json"
    fake_latest.parent.mkdir(parents=True, exist_ok=True)
    fake_latest.write_text(
        json.dumps(
            {
                "benchmark_id": "webshop",
                "benchmark_directory": "webshop",
                "agent": "eliza",
                "status": "succeeded",
                "score": None,
                "run_id": "fake_webshop",
                "run_group_id": "rg_old",
                "signature": "sig-fake",
                "comparison_signature": "cmp-fake",
                "updated_at": "2026-05-11T00:00:00+00:00",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"bfcl": _adapter("bfcl"), "webshop": _adapter("webshop")},
    )

    assert (tmp_path / "latest" / "bfcl__eliza.json").exists()
    assert not fake_latest.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert set(index["latest"]) == {"bfcl::eliza"}


def test_rebuild_latest_prunes_sample_preserved_snapshot_from_partial_db(
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
        run_id="run_bfcl",
        started_at="2026-05-12T00:00:00+00:00",
    )
    fake_latest = tmp_path / "latest" / "gaia__eliza.json"
    fake_latest.parent.mkdir(parents=True, exist_ok=True)
    fake_latest.write_text(
        json.dumps(
            {
                "benchmark_id": "gaia",
                "benchmark_directory": "gaia",
                "agent": "eliza",
                "status": "succeeded",
                "score": 1.0,
                "metrics": {"dataset_source": "sample"},
                "run_id": "fake_gaia_sample",
                "run_group_id": "rg_old",
                "signature": "sig-fake",
                "comparison_signature": "cmp-fake",
                "updated_at": "2026-05-11T00:00:00+00:00",
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"bfcl": _adapter("bfcl"), "gaia": _adapter("gaia")},
    )

    assert (tmp_path / "latest" / "bfcl__eliza.json").exists()
    assert not fake_latest.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert set(index["latest"]) == {"bfcl::eliza"}


def test_rebuild_latest_repairs_succeeded_nonzero_return_code(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
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
        run_id="run_nonzero",
        started_at="2026-05-12T00:00:00+00:00",
        status="succeeded",
        score=0.95,
        metrics={"return_code": 7},
    )

    _rebuild_latest_result_snapshots(conn, tmp_path, {"woobench": _adapter("woobench")})

    assert not (tmp_path / "latest" / "woobench__eliza.json").exists()
    quarantine_payload = json.loads(
        (tmp_path / "quarantine" / "woobench__eliza.json").read_text(encoding="utf-8")
    )
    assert quarantine_payload["status"] == "failed"
    assert quarantine_payload["quarantine_reason"] == "unsucceeded_run"
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    cell = index["matrix_contract"]["benchmarks"]["woobench"]["cells"]["eliza"]
    assert cell["state"] == "failed"
    assert index["matrix_contract"]["summary"]["failed_required_real_cells"] == 1
    assert index["matrix_contract"]["summary"]["missing_required_real_cells"] == 2


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
        {
            "loca_bench": _adapter(
                "loca_bench",
                agent_compatibility=("eliza", "hermes", "openclaw"),
            )
        },
    )

    payload = json.loads(
        (tmp_path / "latest" / "loca_bench__openclaw.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["run_id"] == "run_success"
    assert payload["status"] == "succeeded"


def test_rebuild_latest_routes_current_incompatible_rows_out_of_latest(
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
        run_id="run_incompat",
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
    stale_latest = tmp_path / "latest" / "loca_bench__openclaw.json"
    stale_latest.parent.mkdir(parents=True, exist_ok=True)
    stale_latest.write_text("{}", encoding="utf-8")

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"loca_bench": _adapter("loca_bench", agent_compatibility=("eliza", "hermes"))},
    )

    assert not stale_latest.exists()
    quarantine = tmp_path / "quarantine" / "loca_bench__openclaw.json"
    assert quarantine.exists()
    payload = json.loads(quarantine.read_text(encoding="utf-8"))
    assert payload["status"] == "incompatible"
    assert payload["quarantine_reason"] == "incompatible_harness"
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert index["latest"] == {}
    assert index["matrix_contract"]["benchmarks"]["loca_bench"]["cells"]["openclaw"] == {
        "required": False,
        "state": "unsupported",
        "status": "unsupported",
        "score": None,
        "run_id": None,
        "reason": "harness 'openclaw' not in adapter compatibility (eliza, hermes)",
    }


def test_rebuild_latest_matrix_contract_marks_no_required_real_harness_incomplete(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["gaia"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="gaia",
        agent="eliza",
        run_id="run_unsupported",
        started_at="2026-05-12T00:00:00+00:00",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"gaia": _adapter("gaia", agent_compatibility=())},
    )

    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    contract = index["matrix_contract"]
    assert contract["status"] == "incomplete"
    assert contract["summary"]["complete_benchmarks"] == 0
    assert contract["summary"]["incomplete_benchmarks"] == 1
    assert contract["summary"]["no_required_real_harness_benchmarks"] == 1
    assert contract["benchmarks"]["gaia"]["complete"] is False
    assert (
        contract["benchmarks"]["gaia"]["cells"]["eliza"]["reason"]
        == GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON
    )


def test_rebuild_latest_repairs_stale_success_that_is_now_incompatible(
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
        run_id="run_old_success",
        started_at="2026-05-12T00:00:00+00:00",
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"loca_bench": _adapter("loca_bench", agent_compatibility=("eliza", "hermes"))},
    )

    assert not (tmp_path / "latest" / "loca_bench__openclaw.json").exists()
    quarantine = tmp_path / "quarantine" / "loca_bench__openclaw.json"
    assert quarantine.exists()
    payload = json.loads(quarantine.read_text(encoding="utf-8"))
    assert payload["run_id"] == "run_old_success"
    assert payload["status"] == "incompatible"
    assert payload["quarantine_reason"] == "incompatible_harness"
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    assert index["latest"] == {}
    assert index["matrix_contract"]["benchmarks"]["loca_bench"]["cells"]["openclaw"] == {
        "required": False,
        "state": "unsupported",
        "status": "unsupported",
        "score": None,
        "run_id": None,
        "reason": "harness 'openclaw' not in adapter compatibility (eliza, hermes)",
    }


def test_rebuild_latest_restores_compatibility_repair_when_harness_is_supported_again(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["terminal_bench"],
        repo_meta={},
    )
    result_path = tmp_path / "terminal-result.json"
    result_path.write_text(
        json.dumps({"summary": {"accuracy": 0.75}}, sort_keys=True),
        encoding="utf-8",
    )
    _seed_run(
        conn,
        benchmark_id="terminal_bench",
        agent="hermes",
        run_id="run_restorable",
        started_at="2026-05-12T00:00:00+00:00",
        status="incompatible",
        score=None,
        metrics={
            "reason": "latest_row_violates_current_compatibility",
            "supported_harnesses": [],
        },
        result_json_path=str(result_path),
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"terminal_bench": _adapter("terminal_bench")},
    )

    latest = json.loads(
        (tmp_path / "latest" / "terminal_bench__hermes.json").read_text(
            encoding="utf-8"
        )
    )
    assert latest["status"] == "succeeded"
    assert latest["score"] == 0.75
    assert latest["metrics"]["harness"] == "hermes"
    assert "reason" not in latest["metrics"]


def test_rebuild_latest_restores_voice_scores_from_saved_result_metrics(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["voiceagentbench", "voicebench"],
        repo_meta={},
    )
    voiceagent_result = tmp_path / "voiceagentbench-result.json"
    voiceagent_result.write_text(
        json.dumps({"pass_at_1": 1.0}, sort_keys=True),
        encoding="utf-8",
    )
    voicebench_result = tmp_path / "voicebench-result.json"
    voicebench_result.write_text(
        json.dumps(
            {
                "summary": {
                    "local": {
                        "transcriptionNormalizedAccuracy": 0.8,
                    }
                }
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    for benchmark_id, result_path in (
        ("voiceagentbench", voiceagent_result),
        ("voicebench", voicebench_result),
    ):
        _seed_run(
            conn,
            benchmark_id=benchmark_id,
            agent="eliza",
            run_id=f"run_{benchmark_id}",
            started_at="2026-05-12T00:00:00+00:00",
            status="incompatible",
            score=None,
            metrics={
                "reason": "latest_row_violates_current_compatibility",
                "supported_harnesses": [],
            },
            result_json_path=str(result_path),
        )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "voiceagentbench": _adapter("voiceagentbench", agent_compatibility=("eliza",)),
            "voicebench": _adapter("voicebench", agent_compatibility=("eliza",)),
        },
    )

    voiceagent = json.loads(
        (tmp_path / "latest" / "voiceagentbench__eliza.json").read_text(
            encoding="utf-8"
        )
    )
    voicebench = json.loads(
        (tmp_path / "latest" / "voicebench__eliza.json").read_text(
            encoding="utf-8"
        )
    )
    assert voiceagent["status"] == "succeeded"
    assert voiceagent["score"] == 1.0
    assert voicebench["status"] == "succeeded"
    assert voicebench["score"] == 0.8


def test_rebuild_latest_restores_orchestrated_swe_score_from_saved_result(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["swe_bench_orchestrated"],
        repo_meta={},
    )
    result_path = tmp_path / "swe-bench-orchestrated-result.json"
    result_path.write_text(
        json.dumps({"overall_score": 0.25}, sort_keys=True),
        encoding="utf-8",
    )
    _seed_run(
        conn,
        benchmark_id="swe_bench_orchestrated",
        agent="openclaw",
        run_id="run_restorable_swe_orchestrated",
        started_at="2026-05-12T00:00:00+00:00",
        status="incompatible",
        score=None,
        metrics={
            "reason": "latest_row_violates_current_compatibility",
            "supported_harnesses": [],
        },
        result_json_path=str(result_path),
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {
            "swe_bench_orchestrated": _adapter(
                "swe_bench_orchestrated",
                agent_compatibility=("openclaw",),
            )
        },
    )

    latest = json.loads(
        (tmp_path / "latest" / "swe_bench_orchestrated__openclaw.json").read_text(
            encoding="utf-8"
        )
    )
    assert latest["status"] == "succeeded"
    assert latest["score"] == 0.25


def test_rebuild_latest_restores_swe_score_from_saved_result_metrics(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["swe_bench"],
        repo_meta={},
    )
    result_path = tmp_path / "swe-bench-result.json"
    result_path.write_text(
        json.dumps({"resolve_rate": 0.5}, sort_keys=True),
        encoding="utf-8",
    )
    _seed_run(
        conn,
        benchmark_id="swe_bench",
        agent="hermes",
        run_id="run_restorable_swe",
        started_at="2026-05-12T00:00:00+00:00",
        status="incompatible",
        score=None,
        metrics={
            "reason": "latest_row_violates_current_compatibility",
            "supported_harnesses": [],
        },
        result_json_path=str(result_path),
    )

    _rebuild_latest_result_snapshots(
        conn,
        tmp_path,
        {"swe_bench": _adapter("swe_bench", agent_compatibility=("hermes",))},
    )

    latest = json.loads(
        (tmp_path / "latest" / "swe_bench__hermes.json").read_text(
            encoding="utf-8"
        )
    )
    assert latest["status"] == "succeeded"
    assert latest["score"] == 0.5


def test_rebuild_latest_prunes_unknown_benchmark_snapshots(
    tmp_path: Path,
) -> None:
    conn = connect_database(tmp_path / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id="rg_test",
        created_at="2026-05-12T00:00:00+00:00",
        request={},
        benchmarks=["bfcl", "eliza-format"],
        repo_meta={},
    )
    _seed_run(
        conn,
        benchmark_id="bfcl",
        agent="eliza",
        run_id="run_bfcl",
        started_at="2026-05-12T00:00:00+00:00",
    )
    _seed_run(
        conn,
        benchmark_id="eliza-format",
        agent="eliza",
        run_id="run_unknown",
        started_at="2026-05-12T00:10:00+00:00",
    )
    unknown_latest = tmp_path / "latest" / "eliza-format__eliza.json"
    unknown_latest.parent.mkdir(parents=True, exist_ok=True)
    unknown_latest.write_text("{}", encoding="utf-8")

    _rebuild_latest_result_snapshots(conn, tmp_path, {"bfcl": _adapter("bfcl")})

    assert (tmp_path / "latest" / "bfcl__eliza.json").exists()
    assert not unknown_latest.exists()
    index = json.loads((tmp_path / "latest" / "index.json").read_text(encoding="utf-8"))
    latest_files = {
        path.name
        for path in (tmp_path / "latest").glob("*.json")
        if path.name != "index.json"
    }
    indexed_files = {
        Path(row["path"]).name
        for row in index["latest"].values()
    }
    assert latest_files == indexed_files == {"bfcl__eliza.json"}
