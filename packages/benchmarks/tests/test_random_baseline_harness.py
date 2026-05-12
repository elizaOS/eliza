"""Tests for the ``random_v1`` harness and the ``compare-vs-random`` CLI.

Covers three layers:

1. ``run_random_baseline`` in-process synthesizer — verifies it
   produces the right result-file shape for a known benchmark
   (``bfcl``), correctly reports ``incompatible`` for benchmarks whose
   strategy is uninterpretable (``solana``), and gracefully degrades
   for benchmarks with no result template registered (records via
   metrics only).

2. ``run_compare_vs_random`` — populates a fresh SQLite DB with one
   real agent run and one random_v1 baseline, then asserts the
   function returns 0 when the lift beats the threshold and 1 when
   it doesn't. Output is captured via ``capsys`` to confirm the
   table headers print.

3. CLI dispatch — exercises ``build_parser()`` and verifies
   ``compare-vs-random`` is wired in.
"""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from orchestrator.cli import build_parser  # noqa: E402
from orchestrator.compare_vs_random import run_compare_vs_random  # noqa: E402
from orchestrator.db import (  # noqa: E402
    connect_database,
    initialize_database,
    insert_run_start,
    update_run_result,
)
from orchestrator.random_baseline_runner import (  # noqa: E402
    RandomBaselineOutcome,
    run_random_baseline,
)


# ----------------- in-process synthesizer ------------------


def test_random_baseline_bfcl_writes_result_file(tmp_path: Path) -> None:
    outcome = run_random_baseline(
        benchmark_id="bfcl",
        output_dir=tmp_path,
        score=0.0,
    )
    assert outcome.status == "succeeded"
    assert outcome.is_meaningful is True
    assert outcome.strategy_name == "function_call"
    assert outcome.result_path is not None
    assert outcome.result_path.exists()
    payload = json.loads(outcome.result_path.read_text(encoding="utf-8"))
    assert payload["metrics"]["overall_score"] == 0.0


def test_random_baseline_incompatible_for_solana(tmp_path: Path) -> None:
    outcome = run_random_baseline(
        benchmark_id="solana",
        output_dir=tmp_path,
        score=0.0,
    )
    assert outcome.status == "incompatible"
    assert outcome.is_meaningful is False
    assert outcome.note == "random baseline uninterpretable for this benchmark"
    assert outcome.result_path is None


def test_random_baseline_unknown_benchmark_no_template(tmp_path: Path) -> None:
    # ``tau-bench`` is in the registry as ``function_call`` but has no
    # result template in _RESULT_TEMPLATES — expected to succeed but
    # record via metrics only.
    outcome = run_random_baseline(
        benchmark_id="tau-bench",
        output_dir=tmp_path,
        score=0.0,
    )
    assert outcome.status == "succeeded"
    assert outcome.result_path is None
    assert outcome.note is not None


# ----------------- compare-vs-random orchestration ------------------


def _seed_db(
    *,
    workspace_root: Path,
    benchmark_id: str,
    agent_score: float,
    random_score: float,
    agent_label: str = "eliza",
) -> None:
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect_database(db_path)
    initialize_database(conn)

    # Insert a synthetic run_group_id row by creating one row each.
    # The compare-vs-random query reads benchmark_runs only, but we
    # still need a valid run_group_id FK target to satisfy the schema.
    conn.execute(
        """
        INSERT INTO run_groups (
            run_group_id, created_at, request_json, benchmarks_json,
            repo_meta_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("rg_test", "2026-05-11T00:00:00+00:00", "{}", "[]", "{}", "tests"),
    )

    for run_id, agent, score in (
        ("run_agent", agent_label, agent_score),
        ("run_random", "random_v1", random_score),
    ):
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
            started_at="2026-05-11T00:00:00+00:00",
            command=[],
            cwd=str(workspace_root),
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
            ended_at="2026-05-11T00:00:01+00:00",
            duration_seconds=1.0,
            score=score,
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
    conn.commit()
    conn.close()


def test_compare_vs_random_passes_when_above_min_lift(tmp_path: Path) -> None:
    _seed_db(
        workspace_root=tmp_path,
        benchmark_id="bfcl",
        agent_score=0.8,
        random_score=0.4,  # 2x lift, above 1.5x threshold
    )
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = run_compare_vs_random(
            workspace_root=tmp_path,
            agents=["eliza"],
            benchmarks=["bfcl"],
            min_lift=1.5,
        )
    assert rc == 0
    out = buf.getvalue()
    assert "benchmark" in out
    assert "lift" in out
    assert "2.00x" in out


def test_compare_vs_random_fails_when_below_min_lift(tmp_path: Path) -> None:
    _seed_db(
        workspace_root=tmp_path,
        benchmark_id="bfcl",
        agent_score=0.5,
        random_score=0.4,  # 1.25x, below 1.5x threshold
    )
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = run_compare_vs_random(
            workspace_root=tmp_path,
            agents=["eliza"],
            benchmarks=["bfcl"],
            min_lift=1.5,
        )
    assert rc == 1
    out = buf.getvalue()
    assert "FAIL" in out


def test_compare_vs_random_skips_threshold_when_baseline_missing(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect_database(db_path)
    initialize_database(conn)
    conn.execute(
        """
        INSERT INTO run_groups (
            run_group_id, created_at, request_json, benchmarks_json,
            repo_meta_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("rg_nb", "2026-05-11T00:00:00+00:00", "{}", "[]", "{}", "tests"),
    )
    insert_run_start(
        conn,
        run_id="run_only_agent",
        run_group_id="rg_nb",
        benchmark_id="bfcl",
        benchmark_directory="bfcl",
        signature="sig",
        attempt=1,
        agent="eliza",
        provider="test",
        model="test-model",
        extra_config={},
        started_at="2026-05-11T00:00:00+00:00",
        command=[],
        cwd=str(tmp_path),
        stdout_path="",
        stderr_path="",
        benchmark_version=None,
        benchmarks_commit=None,
        eliza_commit=None,
        eliza_version=None,
    )
    update_run_result(
        conn,
        run_id="run_only_agent",
        status="succeeded",
        ended_at="2026-05-11T00:00:01+00:00",
        duration_seconds=1.0,
        score=0.1,
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
    conn.commit()
    conn.close()

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = run_compare_vs_random(
            workspace_root=tmp_path,
            agents=["eliza"],
            benchmarks=["bfcl"],
            min_lift=1.5,
        )
    # No baseline -> nothing to enforce -> exit 0
    assert rc == 0


# ----------------- CLI dispatch ------------------


def test_build_parser_includes_compare_vs_random() -> None:
    parser = build_parser()
    args = parser.parse_args(
        [
            "compare-vs-random",
            "--agents",
            "eliza,openclaw",
            "--benchmarks",
            "bfcl",
            "--min-lift",
            "2.0",
        ]
    )
    assert args.cmd == "compare-vs-random"
    assert args.agents == "eliza,openclaw"
    assert args.benchmarks == "bfcl"
    assert args.min_lift == pytest.approx(2.0)


def test_random_v1_harness_accepted_by_selected_harnesses() -> None:
    from orchestrator.cli import _selected_harnesses  # noqa: PLC0415

    parser = build_parser()
    args = parser.parse_args(
        [
            "run",
            "--benchmarks",
            "bfcl",
            "--harnesses",
            "eliza,random_v1",
        ]
    )
    harnesses = _selected_harnesses(args)
    assert "eliza" in harnesses
    assert "random_v1" in harnesses
