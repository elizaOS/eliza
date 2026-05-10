"""Tests for the drift benchmark aggregator.

These tests don't run the TS harness or call any model — they verify the
aggregation math against fixture JSONL files written into the test's tmp
directory.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from elizaos_context_bench.drift import (
    KNOWN_STRATEGIES,
    DriftBenchmarkSuite,
    DriftCompactEvent,
    DriftProbeEvent,
    DriftSummaryEvent,
    aggregate_run,
    parse_jsonl,
)


def _write_fixture(tmp_path: Path, lines: list[dict[str, object]]) -> Path:
    p = tmp_path / "drift.jsonl"
    p.write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8"
    )
    return p


def test_known_strategies_are_stable() -> None:
    """Lock in the strategy list — the TS driver depends on it."""
    assert KNOWN_STRATEGIES == (
        "none",
        "prompt-stripping",
        "naive-summary",
        "structured-state",
        "hierarchical-summary",
        "hybrid-ledger",
    )


def test_parse_jsonl_extracts_typed_events(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        [
            {"event": "turn", "turn": 1, "role": "user", "contentLen": 10, "tokens": 3},
            {"event": "turn", "turn": 1, "role": "assistant", "contentLen": 5, "tokens": 2},
            {
                "event": "compact",
                "atTurn": 1,
                "strategy": "none",
                "originalTokens": 100,
                "compactedTokens": 60,
                "latencyMs": 1.0,
            },
            {
                "event": "probe",
                "atTurn": 1,
                "factId": "fact_1",
                "plantedTurn": 1,
                "expected": "X",
                "actual": "X",
                "correct": True,
                "judgeReasoning": "ok",
                "phase": "post-compact",
            },
            {
                "event": "summary",
                "strategy": "none",
                "overallAccuracy": 1.0,
                "totalCompactions": 1,
                "totalTokensSaved": 40,
                "totalProbes": 1,
                "totalCorrect": 1,
                "seed": 42,
                "turns": 1,
                "compactEvery": 1,
                "plantFacts": 1,
            },
        ],
    )
    turns, compacts, probes, summary = parse_jsonl(fixture)
    assert len(turns) == 2
    assert len(compacts) == 1
    assert len(probes) == 1
    assert isinstance(summary, DriftSummaryEvent)
    assert summary.strategy == "none"


def test_aggregate_run_uses_summary_for_totals_and_derives_phases() -> None:
    probes = [
        DriftProbeEvent(
            at_turn=10,
            fact_id="fact_1",
            planted_turn=2,
            expected="X",
            actual="X",
            correct=True,
            judge_reasoning="ok",
            phase="post-compact",
        ),
        DriftProbeEvent(
            at_turn=20,
            fact_id="fact_1",
            planted_turn=2,
            expected="X",
            actual="?",
            correct=False,
            judge_reasoning="missing",
            phase="post-compact",
        ),
        DriftProbeEvent(
            at_turn=20,
            fact_id="fact_1",
            planted_turn=2,
            expected="X",
            actual="?",
            correct=False,
            judge_reasoning="missing",
            phase="final",
        ),
    ]
    compacts = [
        DriftCompactEvent(
            at_turn=10,
            strategy="naive-summary",
            original_tokens=200,
            compacted_tokens=80,
            latency_ms=5.0,
        ),
        DriftCompactEvent(
            at_turn=20,
            strategy="naive-summary",
            original_tokens=200,
            compacted_tokens=80,
            latency_ms=5.0,
        ),
    ]
    summary = DriftSummaryEvent(
        strategy="naive-summary",
        overall_accuracy=1.0 / 3.0,
        total_compactions=2,
        total_tokens_saved=240,
        total_probes=3,
        total_correct=1,
        seed=1,
        turns=20,
        compact_every=10,
        plant_facts=1,
    )
    result = aggregate_run(probes, compacts, summary)
    assert result.strategy == "naive-summary"
    assert result.total_probes == 3
    assert result.total_correct == 1
    assert result.total_compactions == 2
    assert result.total_tokens_saved == 240
    # Final-phase: 1 probe, 0 correct.
    assert result.final_phase_accuracy == pytest.approx(0.0)
    # Post-compact: 2 probes, 1 correct.
    assert result.post_compact_accuracy == pytest.approx(0.5)
    # drift_per_compaction = (1 - 0.5) / 2
    assert result.drift_per_compaction == pytest.approx(0.25)
    assert result.fact_survival == {"fact_1": pytest.approx(1.0 / 3.0)}
    assert result.skipped is False
    assert result.skip_reason is None


def test_aggregate_run_handles_skipped_strategy() -> None:
    compacts = [
        DriftCompactEvent(
            at_turn=10,
            strategy="hybrid-ledger",
            original_tokens=100,
            compacted_tokens=100,
            latency_ms=0.0,
            unavailable=True,
            unavailable_reason="not yet implemented",
        )
    ]
    probes: list[DriftProbeEvent] = []
    summary = DriftSummaryEvent(
        strategy="hybrid-ledger",
        overall_accuracy=0.0,
        total_compactions=0,
        total_tokens_saved=0,
        total_probes=0,
        total_correct=0,
        seed=1,
        turns=10,
        compact_every=10,
        plant_facts=0,
    )
    result = aggregate_run(probes, compacts, summary)
    assert result.skipped is True
    assert result.skip_reason == "not yet implemented"
    assert result.total_compactions == 0
    assert result.overall_accuracy == 0.0


def test_aggregate_run_falls_back_when_summary_missing() -> None:
    """If the JSONL was truncated, derive what we can from probes/compacts."""
    probes = [
        DriftProbeEvent(
            at_turn=5,
            fact_id="fact_1",
            planted_turn=1,
            expected="X",
            actual="X",
            correct=True,
            judge_reasoning="ok",
            phase="final",
        ),
    ]
    compacts = [
        DriftCompactEvent(
            at_turn=5,
            strategy="prompt-stripping",
            original_tokens=200,
            compacted_tokens=180,
            latency_ms=2.0,
        )
    ]
    result = aggregate_run(probes, compacts, summary=None)
    assert result.strategy == "prompt-stripping"
    assert result.total_probes == 1
    assert result.total_correct == 1
    assert result.total_compactions == 1
    assert result.total_tokens_saved == 20
    assert result.final_phase_accuracy == pytest.approx(1.0)


def test_suite_aggregate_end_to_end(tmp_path: Path) -> None:
    fixture = _write_fixture(
        tmp_path,
        [
            {"event": "turn", "turn": 1, "role": "user", "contentLen": 10, "tokens": 3},
            {
                "event": "compact",
                "atTurn": 1,
                "strategy": "none",
                "originalTokens": 50,
                "compactedTokens": 30,
                "latencyMs": 1.0,
            },
            {
                "event": "probe",
                "atTurn": 1,
                "factId": "fact_1",
                "plantedTurn": 1,
                "expected": "Y",
                "actual": "Z",
                "correct": False,
                "judgeReasoning": "wrong",
                "phase": "post-compact",
            },
            {
                "event": "probe",
                "atTurn": 1,
                "factId": "fact_1",
                "plantedTurn": 1,
                "expected": "Y",
                "actual": "Y",
                "correct": True,
                "judgeReasoning": "ok",
                "phase": "final",
            },
            {
                "event": "summary",
                "strategy": "none",
                "overallAccuracy": 0.5,
                "totalCompactions": 1,
                "totalTokensSaved": 20,
                "totalProbes": 2,
                "totalCorrect": 1,
                "seed": 1,
                "turns": 1,
                "compactEvery": 1,
                "plantFacts": 1,
            },
        ],
    )
    suite = DriftBenchmarkSuite()
    summary = suite.aggregate(fixture)
    assert summary.overall_accuracy == pytest.approx(0.5)
    assert summary.final_phase_accuracy == pytest.approx(1.0)
    assert summary.post_compact_accuracy == pytest.approx(0.0)
    assert summary.fact_survival["fact_1"] == pytest.approx(0.5)


def test_run_drift_eval_rejects_unknown_strategy(tmp_path: Path) -> None:
    suite = DriftBenchmarkSuite(repo_root=tmp_path)
    with pytest.raises(ValueError, match="unknown strategy"):
        suite.run_drift_eval(["nonexistent"], output_dir=tmp_path)


def test_repo_root_autodetected_in_real_workspace() -> None:
    """The default DriftBenchmarkSuite should locate the repo root."""
    suite = DriftBenchmarkSuite()
    assert (suite.repo_root / "packages").is_dir()
    assert (suite.repo_root / "scripts").is_dir()
    assert suite.harness_script.name == "drift-harness.ts"


def test_parse_jsonl_rejects_non_object_lines(tmp_path: Path) -> None:
    p = tmp_path / "bad.jsonl"
    p.write_text("[1,2,3]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="non-object"):
        parse_jsonl(p)


def test_parse_jsonl_skips_unknown_event_kinds(tmp_path: Path) -> None:
    """Forward-compat: harness may add new event kinds — we must not crash."""
    p = tmp_path / "future.jsonl"
    p.write_text(
        json.dumps({"event": "future-thing", "value": 42}) + "\n", encoding="utf-8"
    )
    turns, compacts, probes, summary = parse_jsonl(p)
    assert turns == [] and compacts == [] and probes == []
    assert summary is None
