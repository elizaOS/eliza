#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_cache_pressure_evidence.py"

spec = importlib.util.spec_from_file_location("check_cache_pressure_evidence", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


def measured_report(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "schema": gate.SCHEMA,
        "source": "cocotb-cache-pressure",
        "coverage": ["l1d", "l2", "l3", "slc"],
        "contention_agents": ["cpu_miss_stream", "display_qos"],
        "metrics": {
            "attempted_misses": 8,
            "completed_misses": 8,
            "blocked_cycles": 1,
            "max_in_flight_misses": 2,
            "display_service_window_violations": 0,
            "p95_miss_latency_cycles": 40,
        },
    }
    data.update(overrides)
    return data


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def test_valid_cocotb_report_passes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report())
        report = gate.build_report(path)
    if report["status"] != "pass":
        raise AssertionError(report)
    print("PASS valid cache pressure cocotb report accepted")


def test_phone_claim_level_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report(claim_level="L5_PROTOTYPE_SILICON"))
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "claim_level" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure rejects L5/L6 claim level")


def test_real_target_class_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report(evidence_class="real_target_measurement"))
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "evidence_class" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure rejects real-target evidence class")


def test_partial_coverage_blocks_claim() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(
            path,
            measured_report(
                coverage=["l1d"],
                contention_agents=["cpu_miss_stream"],
            ),
        )
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    names = {item["name"] for item in report["findings"]}
    if not {"coverage", "contention_agents"}.issubset(names):
        raise AssertionError(report["findings"])
    print("PASS cache pressure requires hierarchy and contention coverage")


def main() -> None:
    test_valid_cocotb_report_passes()
    test_phone_claim_level_rejected()
    test_real_target_class_rejected()
    test_partial_coverage_blocks_claim()


if __name__ == "__main__":
    main()
