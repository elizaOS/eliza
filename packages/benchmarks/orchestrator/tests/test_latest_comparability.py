from __future__ import annotations

import argparse
import json
from pathlib import Path

from benchmarks.orchestrator import cli
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


def _code_agent_index(benchmark_id: str) -> dict:
    return {
        "matrix_contract": {
            "benchmarks": {
                benchmark_id: {
                    "cells": {
                        "elizaos_vs_opencode": {
                            "required": True,
                            "state": "succeeded",
                            "status": "succeeded",
                            "score": 1.0,
                        }
                    }
                }
            }
        }
    }


def _code_agent_row(
    benchmark_id: str,
    *,
    score: float = 1.0,
    comparison_status: str = "comparable",
    status: str = "succeeded",
) -> dict:
    row = _row(
        benchmark_id,
        "elizaos_vs_opencode",
        score,
        signature=f"{benchmark_id}-code-agent",
    )
    row["status"] = status
    row["comparison_status"] = comparison_status
    return row


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


def test_latest_comparability_filters_excluded_benchmarks(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    index = _index("terminal_bench")
    index["matrix_contract"]["benchmarks"]["voicebench"] = _index("voicebench")[
        "matrix_contract"
    ]["benchmarks"]["voicebench"]
    _write_json(latest / "index.json", index)
    _write_json(latest / "terminal_bench__eliza.json", _row("terminal_bench", "eliza", 1.0))
    _write_json(latest / "voicebench__eliza.json", _row("voicebench", "eliza", 1.0))
    _write_json(latest / "voicebench__hermes.json", _row("voicebench", "hermes", 1.0))
    _write_json(latest / "voicebench__openclaw.json", _row("voicebench", "openclaw", 1.0))

    report = validate_latest_comparability(
        tmp_path,
        tolerance=0.08,
        exclude_benchmarks={"terminal_bench"},
    )

    assert report.ok
    assert report.checked_benchmarks == 1


def test_latest_comparability_filtered_scope_requires_selected_benchmark(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("terminal_bench"))
    _write_json(latest / "terminal_bench__eliza.json", _row("terminal_bench", "eliza", 1.0))
    _write_json(latest / "terminal_bench__hermes.json", _row("terminal_bench", "hermes", 1.0))
    _write_json(latest / "terminal_bench__openclaw.json", _row("terminal_bench", "openclaw", 1.0))

    report = validate_latest_comparability(
        tmp_path,
        tolerance=0.08,
        exclude_benchmarks={"terminal_bench"},
    )

    assert not report.ok
    assert report.checked_benchmarks == 0
    assert any(
        finding.reason == "no_selected_benchmarks"
        for finding in report.findings
    )


def test_latest_comparability_include_filter_requires_matching_benchmark(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _index("voicebench"))
    _write_json(latest / "voicebench__eliza.json", _row("voicebench", "eliza", 1.0))
    _write_json(latest / "voicebench__hermes.json", _row("voicebench", "hermes", 1.0))
    _write_json(latest / "voicebench__openclaw.json", _row("voicebench", "openclaw", 1.0))

    report = validate_latest_comparability(
        tmp_path,
        tolerance=0.08,
        include_benchmarks={"terminal_bench"},
    )

    assert not report.ok
    assert report.checked_benchmarks == 0
    assert any(
        finding.reason == "no_selected_benchmarks"
        for finding in report.findings
    )


def test_latest_comparability_checks_code_agent_required_cell(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _code_agent_index("swe_bench"))
    _write_json(
        latest / "swe_bench__elizaos_vs_opencode.json",
        _code_agent_row("swe_bench", comparison_status="inferior"),
    )

    report = validate_latest_comparability(tmp_path)

    assert not report.ok
    assert report.checked_benchmarks == 1
    assert report.findings[0].benchmark_id == "swe_bench"
    assert report.findings[0].reason == "code_agent_not_comparable_or_better"
    assert report.findings[0].value == "inferior"


def test_latest_comparability_rejects_mislabeled_code_agent_status(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _code_agent_index("swe_bench"))
    row = _code_agent_row("swe_bench", comparison_status="superior")
    row.update(
        {
            "target_accuracy": 1.0,
            "baseline_accuracy": 1.0,
            "target_right": 1,
            "target_total": 1,
            "baseline_right": 1,
            "baseline_total": 1,
        }
    )
    _write_json(latest / "swe_bench__elizaos_vs_opencode.json", row)

    report = validate_latest_comparability(tmp_path)

    assert not report.ok
    assert any(
        finding.benchmark_id == "swe_bench"
        and finding.reason == "code_agent_comparison_status_mismatch"
        and '"expected_status": "comparable"' in finding.value
        for finding in report.findings
    )


def test_latest_comparability_flags_missing_code_agent_row(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _code_agent_index("terminal_bench"))

    report = validate_latest_comparability(tmp_path)

    assert not report.ok
    assert report.findings[0].reason == "missing_required_latest_rows"
    assert report.findings[0].value == "elizaos_vs_opencode"


def test_latest_comparability_cli_accepts_latest_dir_and_filters(
    tmp_path: Path,
    capsys,
) -> None:
    latest = tmp_path / "custom-latest"
    _write_json(latest / "index.json", _code_agent_index("swe_bench"))
    _write_json(
        latest / "swe_bench__elizaos_vs_opencode.json",
        _code_agent_row("swe_bench"),
    )

    code = cli._cmd_validate_latest_comparability(
        argparse.Namespace(
            tolerance=0.08,
            latest_dir=str(latest),
            include_benchmarks="swe_bench",
            exclude_benchmarks="",
            json=True,
        )
    )

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["ok"] is True
    assert payload["latest_dir"] == str(latest)
    assert payload["checked_benchmarks"] == 1
