from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.latest_comparability import validate_latest_comparability


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def _row(benchmark_id: str, agent: str, score: float, signature: str = "cmp") -> dict:
    return {
        "benchmark_id": benchmark_id,
        "benchmark_directory": benchmark_id,
        "agent": agent,
        "provider": "test",
        "model": "test-model",
        "extra_config": {},
        "status": "succeeded",
        "score": score,
        "comparison_signature": signature,
    }


def _index(benchmark_id: str, required: tuple[str, ...] = ("eliza", "hermes", "openclaw")) -> dict:
    return {
        "matrix_contract": {
            "benchmarks": {
                benchmark_id: {
                    "cells": {
                        agent: {"required": agent in required}
                        for agent in ("eliza", "hermes", "openclaw")
                    }
                }
            }
        }
    }


def test_latest_comparability_allows_close_matching_scores(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("woobench"))
    _write_json(latest / "woobench__eliza.json", _row("woobench", "eliza", 0.80))
    _write_json(latest / "woobench__hermes.json", _row("woobench", "hermes", 0.82))
    _write_json(latest / "woobench__openclaw.json", _row("woobench", "openclaw", 0.84))

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    assert report.ok
    assert report.checked_benchmarks == 1


def test_latest_comparability_flags_missing_required_rows(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("bfcl"))
    _write_json(latest / "bfcl__eliza.json", _row("bfcl", "eliza", 1.0))
    _write_json(latest / "bfcl__hermes.json", _row("bfcl", "hermes", 1.0))

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    assert not report.ok
    assert report.findings[0].reason == "missing_required_latest_rows"
    assert report.findings[0].value == "openclaw"


def test_latest_comparability_flags_mixed_signatures_and_score_spread(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("mt_bench"))
    eliza = _row("mt_bench", "eliza", 0.1, "cmp-a")
    hermes = _row("mt_bench", "hermes", 0.9, "cmp-a")
    openclaw = _row("mt_bench", "openclaw", 0.9, "cmp-b")
    openclaw["extra_config"] = {"question_set": "different"}
    _write_json(latest / "mt_bench__eliza.json", eliza)
    _write_json(latest / "mt_bench__hermes.json", hermes)
    _write_json(latest / "mt_bench__openclaw.json", openclaw)

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    reasons = {finding.reason for finding in report.findings}
    assert "mixed_comparison_signatures" in reasons
    assert "score_spread_exceeds_tolerance" in reasons


def test_latest_comparability_allows_known_harness_specific_score_spread(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("hermes_terminalbench_2"))
    _write_json(
        latest / "hermes_terminalbench_2__eliza.json",
        _row("hermes_terminalbench_2", "eliza", 1.0),
    )
    _write_json(
        latest / "hermes_terminalbench_2__hermes.json",
        _row("hermes_terminalbench_2", "hermes", 0.0),
    )
    _write_json(
        latest / "hermes_terminalbench_2__openclaw.json",
        _row("hermes_terminalbench_2", "openclaw", 1.0),
    )

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    assert report.ok


def test_latest_comparability_ignores_unsupported_harnesses(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("vision_language", required=("eliza",)))
    _write_json(latest / "vision_language__eliza.json", _row("vision_language", "eliza", 0.0))

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    assert report.ok


def test_latest_comparability_uses_relative_tolerance_for_large_scores(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("vending_bench"))
    _write_json(latest / "vending_bench__eliza.json", _row("vending_bench", "eliza", 582.5))
    _write_json(latest / "vending_bench__hermes.json", _row("vending_bench", "hermes", 579.12))
    _write_json(latest / "vending_bench__openclaw.json", _row("vending_bench", "openclaw", 582.75))

    report = validate_latest_comparability(tmp_path, tolerance=0.08)

    assert report.ok
