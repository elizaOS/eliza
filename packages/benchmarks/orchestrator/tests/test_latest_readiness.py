from __future__ import annotations

import json
from pathlib import Path

from benchmarks.orchestrator.latest_readiness import validate_latest_readiness


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def _row(benchmark_id: str, agent: str, score: float = 1.0) -> dict:
    return {
        "benchmark_id": benchmark_id,
        "benchmark_directory": benchmark_id,
        "agent": agent,
        "provider": "test",
        "model": "test-model",
        "extra_config": {},
        "status": "succeeded",
        "score": score,
    }


def _contract(
    benchmark_id: str,
    *,
    unsupported: tuple[str, ...] = (),
) -> dict:
    cells = {}
    for agent in ("eliza", "hermes", "openclaw"):
        if agent in unsupported:
            cells[agent] = {
                "required": False,
                "state": "unsupported",
                "status": "unsupported",
                "score": None,
                "reason": "test unavailable",
            }
        else:
            cells[agent] = {
                "required": True,
                "state": "succeeded",
                "status": "succeeded",
                "score": 1.0,
            }
    complete = not unsupported
    return {
        "matrix_contract": {
            "status": "complete" if complete else "incomplete",
            "summary": {
                "unsupported_real_cells": len(unsupported),
                "missing_required_real_cells": 0,
                "failed_required_real_cells": 0,
                "no_required_real_harness_benchmarks": 0,
            },
            "benchmarks": {
                benchmark_id: {
                    "complete": complete,
                    "cells": cells,
                }
            },
        }
    }


def test_latest_readiness_passes_complete_publishable_comparable_matrix(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _contract("bfcl"))
    for agent in ("eliza", "hermes", "openclaw"):
        _write_json(latest / f"bfcl__{agent}.json", _row("bfcl", agent))

    report = validate_latest_readiness(tmp_path, check_runtime_gates=False)

    assert report.ok


def test_latest_readiness_fails_unsupported_cells_with_reason(tmp_path: Path) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _contract("terminal_bench", unsupported=("hermes",)))
    _write_json(latest / "terminal_bench__eliza.json", _row("terminal_bench", "eliza"))
    _write_json(latest / "terminal_bench__openclaw.json", _row("terminal_bench", "openclaw"))

    report = validate_latest_readiness(tmp_path, check_runtime_gates=False)

    assert not report.ok
    reasons = {finding.reason for finding in report.findings}
    assert "matrix_contract_incomplete" in reasons
    assert "unsupported_real_cells" in reasons
    assert "unsupported" in reasons


def test_latest_readiness_includes_publishability_and_comparability_findings(
    tmp_path: Path,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _contract("woobench"))
    _write_json(latest / "woobench__eliza.json", _row("woobench", "eliza", 0.0))
    _write_json(latest / "woobench__hermes.json", _row("woobench", "hermes", 1.0))
    bad_openclaw = _row("woobench", "openclaw", 1.0)
    bad_openclaw["metrics"] = {"sample": True}
    _write_json(latest / "woobench__openclaw.json", bad_openclaw)

    report = validate_latest_readiness(
        tmp_path,
        tolerance=0.08,
        check_runtime_gates=False,
    )

    reasons = {finding.reason for finding in report.findings}
    assert "truthy_non_real_flag" in reasons
    assert "score_spread_exceeds_tolerance" in reasons


def test_latest_readiness_includes_current_runtime_gate_findings(
    tmp_path: Path,
    monkeypatch,
) -> None:
    latest = tmp_path / "benchmarks" / "benchmark_results" / "latest"
    _write_json(latest / "index.json", _contract("bfcl"))
    for agent in ("eliza", "hermes", "openclaw"):
        _write_json(latest / f"bfcl__{agent}.json", _row("bfcl", agent))

    from benchmarks.orchestrator import adapters

    monkeypatch.setattr(adapters, "_has_gaia_official_dataset", lambda: False)
    monkeypatch.setattr(adapters, "_has_hyperliquid_live_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_terminal_bench_docker_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_hermes_sandbox_backend", lambda: True)
    monkeypatch.setattr(adapters, "_has_textvqa_real_inputs", lambda: True)
    monkeypatch.setattr(adapters, "_has_vision_language_harness_runtime", lambda: True)

    report = validate_latest_readiness(tmp_path)

    assert not report.ok
    assert any(
        finding.scope == "runtime_gate:gaia_official_dataset"
        and finding.reason == "runtime_gate_blocked"
        for finding in report.findings
    )
