#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_cpu_phone_benchmark_claim_gate.py"

spec = importlib.util.spec_from_file_location("check_cpu_phone_benchmark_claim_gate", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def side_result(name: str, status: str = "passed") -> dict[str, Any]:
    return {
        "schema": gate.REQUIRED_SIDE_SCHEMA,
        "benchmark": name,
        "status": status,
        "result_recorded_at": "2026-05-22T00:00:00Z",
        "manifest": f"benchmarks/cpu/{name}/manifest.json",
    }


def valid_benchmark_report() -> dict[str, Any]:
    process_sha = "a" * 64
    raw_sha = "b" * 64
    return {
        "schema": "eliza.benchmark_run.v1",
        "report_id": "cpu-phone-test",
        "date_utc": "2026-05-22T00:00:00+00:00",
        "dry_run": False,
        "claim_level": "L5_PROTOTYPE_SILICON",
        "platform": {
            "name": "e1-phone-prototype",
            "revision": "evt",
            "source_tree_sha": "unknown",
            "host": "target",
            "host_system": "linux",
        },
        "software": {
            "os": "linux",
            "kernel": "test",
            "firmware": "test",
            "runtime": "bare",
            "build_id": "test",
        },
        "clocks": {
            "source": "measured",
            "cpu_hz": 1000000000,
            "npu_hz": 1,
            "memory_hz": 1,
            "governor": "performance",
        },
        "memory": {
            "type": "lpddr",
            "capacity_bytes": 1,
            "bandwidth_bytes_per_second": 1,
            "channels": 1,
        },
        "thermal": {
            "ambient_c": 25,
            "die_c": 40,
            "cooling": "passive",
            "throttle_state": "none",
        },
        "power": {
            "source": "meter",
            "watts": 1.0,
            "measurement_method": "shunt",
            "sample_count": 1,
            "averaging_window_seconds": 1.0,
        },
        "process": {
            "node": "14A-test",
            "pdk": "test",
            "process_effects_contract": {
                "path": gate.load_benchmark_runner().PROCESS_EFFECTS_CONTRACT_PATH,
                "sha256": process_sha,
            },
            "process_corner_count": 1,
            "worst_process_corner": "14a_tt",
            "pdk_signoff_claim": gate.load_benchmark_runner().PROCESS_PDK_SIGNOFF_PASSED,
        },
        "calibration": {
            "status": "calibrated",
            "source": "lab",
            "ground_truth_reference": "meter",
            "last_calibrated_utc": "2026-05-22T00:00:00+00:00",
            "assets": {
                "clock_source": {
                    "status": "calibrated",
                    "source": "lab",
                    "sha256": "c" * 64,
                    "evidence": "clock transcript",
                },
                "power_meter": {
                    "status": "calibrated",
                    "source": "lab",
                    "sha256": "d" * 64,
                    "evidence": "power transcript",
                },
                "lmbench_binary": {
                    "status": "calibrated",
                    "source": "build",
                    "sha256": "e" * 64,
                    "evidence": "binary hash",
                },
                "memory_model": {
                    "status": "calibrated",
                    "source": "board",
                    "sha256": "f" * 64,
                    "evidence": "memory manifest",
                },
            },
        },
        "config": {"version": "test", "benchmarks": []},
        "results": [
            {
                "name": "lmbench_bw_mem",
                "suite": "lmbench",
                "version": "test",
                "command": ["bw_mem", "64M", "rd"],
                "input_dataset": "64M read",
                "primary_metric": "memory bandwidth",
                "units": "MB/s",
                "dependencies": [],
                "artifacts": {"raw_output": "bw.log", "raw_output_sha256": raw_sha},
                "status": "passed",
                "parser": "lmbench_bw_mem",
                "provenance": "measured",
                "metrics": {"bandwidth_mb_per_s": 1.0},
                "run_metadata": {
                    "required_metrics": ["bandwidth_mb_per_s"],
                    "required_calibration_assets": [
                        "clock_source",
                        "power_meter",
                        "lmbench_binary",
                        "memory_model",
                    ],
                },
            },
            {
                "name": "lmbench_lat_mem_rd",
                "suite": "lmbench",
                "version": "test",
                "command": ["lat_mem_rd", "64M", "128"],
                "input_dataset": "64M stride sweep",
                "primary_metric": "memory latency",
                "units": "ns",
                "dependencies": [],
                "artifacts": {"raw_output": "lat.log", "raw_output_sha256": raw_sha},
                "status": "passed",
                "parser": "lmbench_lat_mem_rd",
                "provenance": "measured",
                "metrics": {"max_latency_ns": 1.0},
                "run_metadata": {
                    "required_metrics": ["max_latency_ns"],
                    "required_calibration_assets": [
                        "clock_source",
                        "power_meter",
                        "lmbench_binary",
                        "memory_model",
                    ],
                },
            },
        ],
    }


def with_temp_root() -> tuple[tempfile.TemporaryDirectory[str], Path]:
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    return tmp, root


def configure_root(root: Path) -> None:
    gate.ROOT = root
    gate.OUT = root / "build/reports/cpu_phone_benchmark_claim_gate.json"
    gate.DEFAULT_REPORT = root / "benchmarks/results/cpu-phone/report.json"
    gate.SIDE_RESULT_SPECS = {
        "spec_cpu2017": root / "benchmarks/results/cpu/spec/result.json",
        "coremark": root / "benchmarks/results/cpu/coremark/result.json",
        "dhrystone": root / "benchmarks/results/cpu/dhrystone/result.json",
        "jetstream2": root / "benchmarks/results/cpu/jetstream/result.json",
    }


def populate_valid_root(root: Path) -> Path:
    configure_root(root)
    for name, path in gate.SIDE_RESULT_SPECS.items():
        write_json(path, side_result(name))
    report_path = root / "benchmarks/results/cpu-phone/report.json"
    write_json(report_path, valid_benchmark_report())
    return report_path


def expect_status(report: dict[str, Any], status: str) -> None:
    if report["status"] != status:
        raise AssertionError(f"expected {status}, got {report}")


def test_valid_claim_passes() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        expect_status(gate.build_report(report_path), "pass")
    print("PASS valid phone CPU claim evidence accepted")


def test_blocked_side_result_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        write_json(gate.SIDE_RESULT_SPECS["coremark"], side_result("coremark", "blocked"))
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        if not any(item["name"] == "coremark" for item in report["findings"]):
            raise AssertionError(report["findings"])
    print("PASS blocked side-result blocks phone CPU claim")


def test_missing_lmbench_result_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = valid_benchmark_report()
        payload["results"] = [payload["results"][0]]
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        if not any(item["name"] == "lmbench_lat_mem_rd" for item in report["findings"]):
            raise AssertionError(report["findings"])
    print("PASS missing lmbench latency blocks phone CPU claim")


def test_l2_report_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["claim_level"] = "L2_ARCH_SIM"
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        if not any(item["name"] == "benchmark_report_claim_level" for item in report["findings"]):
            raise AssertionError(report["findings"])
    print("PASS L2 report cannot back phone CPU claim")


def test_missing_raw_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        del payload["results"][0]["artifacts"]["raw_output_sha256"]
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        if not any("raw_output_sha256" in str(item.get("reason")) for item in report["findings"]):
            raise AssertionError(report["findings"])
    print("PASS missing raw-output hash blocks phone CPU claim")


def test_missing_report_includes_real_run_command() -> None:
    tmp, root = with_temp_root()
    with tmp:
        configure_root(root)
        for name, path in gate.SIDE_RESULT_SPECS.items():
            write_json(path, side_result(name))
        report = gate.build_report(root / "benchmarks/results/cpu-phone/report.json")
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "benchmark_report")
        if "--report-id cpu-phone" not in finding.get("next_command", ""):
            raise AssertionError(finding)
        if "target-built bw_mem" not in finding.get("requirements", ""):
            raise AssertionError(finding)
    print("PASS missing phone report names real-run command")


def test_blocked_lmbench_result_summarizes_requirements() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["results"][0]["status"] = "blocked"
        payload["results"][0]["blocked_requirements"] = [
            {
                "name": "calibration.assets.lmbench_binary.status",
                "reason": "uncalibrated_asset",
            }
        ]
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "calibration.assets.lmbench_binary.status" not in finding.get(
            "blocked_requirements_summary", ""
        ):
            raise AssertionError(finding)
    print("PASS blocked lmbench result summarizes requirements")


def main() -> None:
    test_valid_claim_passes()
    test_blocked_side_result_blocks_claim()
    test_missing_lmbench_result_blocks_claim()
    test_l2_report_blocks_claim()
    test_missing_raw_hash_blocks_claim()
    test_missing_report_includes_real_run_command()
    test_blocked_lmbench_result_summarizes_requirements()


if __name__ == "__main__":
    main()
