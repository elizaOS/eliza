#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from datetime import datetime, timezone
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
    result_artifacts = {
        top: {
            "path": gate.rel(path),
            "sha256": gate.sha256_file(path),
        }
        for top, (path, _testcase) in gate.EXPECTED_JUNIT_RESULTS.items()
    }
    data: dict[str, Any] = {
        "schema": gate.SCHEMA,
        "source": "cocotb-cache-pressure",
        "status": "pass",
        "evidence_class": gate.MEASURED_EVIDENCE_CLASS,
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "captured_utc": datetime.now(timezone.utc).isoformat(),
        "claim_boundary": (
            "This cocotb report measures RTL pressure behavior only. It is not "
            "phone, release, L5/L6 silicon, DRAM, LPDDR, Android, or bandwidth evidence."
        ),
        "generated_by": "verify/cocotb/cache/test_cache_pressure.py",
        "generated_by_sha256": gate.sha256_file(gate.REQUIRED_HARNESS),
        "cocotb_top_levels": ["e1_l1d_cache", "e1_l2_tb", "e1_l3_tb", "e1_slc_tb"],
        "result_artifacts": result_artifacts,
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
    if report["rtl_pressure_claim_allowed"] is not True:
        raise AssertionError(report)
    for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
        if report.get(claim_field) is not False:
            raise AssertionError(report)
    print("PASS valid cache pressure cocotb report accepted")


def test_generic_claim_flag_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report(claim_allowed=True))
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "claim_allowed" for item in report["findings"]):
        raise AssertionError(report["findings"])
    if report.get("rtl_pressure_claim_allowed") is not False:
        raise AssertionError(report)
    print("PASS cache pressure rejects generic claim flag")


def test_missing_claim_flags_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        payload = measured_report()
        payload.pop("claim_allowed")
        payload.pop("phone_claim_allowed")
        payload.pop("release_claim_allowed")
        write_json(path, payload)
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    names = {item["name"] for item in report["findings"]}
    if not {"claim_allowed", "phone_claim_allowed", "release_claim_allowed"}.issubset(names):
        raise AssertionError(report["findings"])
    print("PASS cache pressure requires explicit false claim flags")


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


def test_missing_measured_provenance_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        payload = measured_report()
        payload.pop("generated_by")
        write_json(path, payload)
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "generated_by" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure requires cocotb harness provenance")


def test_harness_hash_mismatch_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report(generated_by_sha256="0" * 64))
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "generated_by_sha256" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure rejects stale harness hash")


def test_stale_blocked_status_remains_blocked() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report(status="blocked"))
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if report.get("rtl_pressure_claim_allowed") is not False:
        raise AssertionError(report)
    if not any(item["name"] == "status" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure keeps stale blocked producer status fail-closed")


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


def test_missing_result_artifacts_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        payload = measured_report()
        payload.pop("result_artifacts")
        write_json(path, payload)
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(item["name"] == "result_artifacts" for item in report["findings"]):
        raise AssertionError(report["findings"])
    print("PASS cache pressure requires JUnit result artifact bindings")


def test_result_artifact_hash_mismatch_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        payload = measured_report()
        payload["result_artifacts"]["e1_l1d_cache"]["sha256"] = "0" * 64
        write_json(path, payload)
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    if not any(
        item["name"] == "result_artifacts.e1_l1d_cache.sha256"
        and item["status"] == "invalid"
        for item in report["findings"]
    ):
        raise AssertionError(report["findings"])
    print("PASS cache pressure rejects mismatched JUnit artifact hash")


def test_metric_sanity_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        payload = measured_report(
            metrics={
                "attempted_misses": 4,
                "completed_misses": 5,
                "blocked_cycles": -1,
                "max_in_flight_misses": 2,
                "display_service_window_violations": -1,
                "p95_miss_latency_cycles": 0,
            }
        )
        write_json(path, payload)
        report = gate.build_report(path)
    if report["status"] != "blocked":
        raise AssertionError(report)
    names = {item["name"] for item in report["findings"]}
    expected = {
        "completed_misses",
        "blocked_cycles",
        "display_service_window_violations",
        "p95_miss_latency_cycles",
    }
    if not expected.issubset(names):
        raise AssertionError(report["findings"])
    print("PASS cache pressure rejects nonsensical metric values")


def test_measured_report_keeps_memory_blockers_visible_without_blocking_rtl_claim() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "cache_pressure_report.json"
        write_json(path, measured_report())
        report = gate.build_report(path)
    if report["status"] != "pass":
        raise AssertionError(report)
    if report.get("rtl_pressure_claim_allowed") is not True:
        raise AssertionError(report)
    if report.get("memory_blocked_count", 0) <= 0:
        raise AssertionError(report)
    if not any(
        item["name"] == "l5_l6_memory_real_target_reports"
        for item in report["findings"]
    ):
        raise AssertionError(report["findings"])
    print("PASS cache pressure measured report still surfaces memory blockers")


def main() -> None:
    test_valid_cocotb_report_passes()
    test_generic_claim_flag_rejected()
    test_missing_claim_flags_rejected()
    test_phone_claim_level_rejected()
    test_real_target_class_rejected()
    test_missing_measured_provenance_rejected()
    test_harness_hash_mismatch_rejected()
    test_stale_blocked_status_remains_blocked()
    test_partial_coverage_blocks_claim()
    test_missing_result_artifacts_rejected()
    test_result_artifact_hash_mismatch_rejected()
    test_metric_sanity_rejected()
    test_measured_report_keeps_memory_blockers_visible_without_blocking_rtl_claim()


if __name__ == "__main__":
    main()
