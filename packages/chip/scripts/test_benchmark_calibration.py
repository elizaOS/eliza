#!/usr/bin/env python3
"""Regression tests for benchmark calibration fail-closed behavior."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "benchmarks/run_benchmarks.py"
BLOCKED_METADATA = ROOT / "benchmarks/metadata/strict-blocked-template.json"
LOCAL_HOST_METADATA = ROOT / "benchmarks/metadata/local-host-smoke.json"


def run_runner(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(RUNNER), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def write_config(path: Path, benchmark: dict[str, object]) -> None:
    path.write_text(
        json.dumps({"version": "test", "benchmarks": [benchmark]}, indent=2) + "\n",
        encoding="utf-8",
    )


def test_parsed_metric_with_blocked_calibration_fails_schema() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        config = root / "config.json"
        out_dir = root / "out"
        write_config(
            config,
            {
                "name": "fake_coremark",
                "suite": "CoreMark",
                "version": "test",
                "command": [sys.executable, "-c", "print('CoreMark/MHz : 1.0')"],
                "input_dataset": "synthetic",
                "primary_metric": "CoreMark/MHz",
                "units": "score_per_mhz",
                "parser": "coremark_v1",
                "required_metadata": [
                    "software",
                    "clocks",
                    "memory",
                    "thermal",
                    "power",
                    "calibration",
                ],
                "required_metrics": ["coremark_per_mhz"],
                "required_calibration_assets": ["clock_source"],
            },
        )
        result = run_runner(
            [
                "run",
                "--config",
                str(config),
                "--out-dir",
                str(out_dir),
                "--metadata",
                str(BLOCKED_METADATA),
                "--report-id",
                "blocked-calibration",
                "--strict-missing",
            ]
        )
        report = json.loads(
            (out_dir / "blocked-calibration/report.json").read_text(encoding="utf-8")
        )
    if result.returncode != 2:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    if row.get("status") != "blocked":
        raise AssertionError(json.dumps(row, indent=2))
    for token in ("fake_coremark: blocked", "blocked requirements", "calibration.status"):
        if token not in result.stdout:
            raise AssertionError(result.stdout)


def test_uncalibrated_simulator_metrics_fail_instead_of_passing() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        metrics = root / "sim.json"
        metrics.write_text(
            json.dumps(
                {
                    "schema": "eliza.simulator_arch_metrics.v1",
                    "evidence_class": "qemu_virt_liveness_only",
                    "claim_boundary": "not_performance_evidence",
                    "calibration_status": "uncalibrated",
                    "benchmark_success_allowed": False,
                    "target_cycles": 0,
                    "simulated_frequency_hz": 0,
                    "ipc": 0,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        config = root / "config.json"
        out_dir = root / "out"
        metadata = root / "metadata.json"
        write_config(
            config,
            {
                "name": "fake_simulator_arch_metrics",
                "suite": "Eliza simulator metrics",
                "version": "test",
                "command": [sys.executable, "-c", f"print(open({str(metrics)!r}).read())"],
                "input_dataset": "simulator metrics JSON",
                "primary_metric": "target_cycles",
                "units": "cycles",
                "parser": "simulator_metrics_v1",
                "provenance": "simulator",
                "required_metadata": ["software", "clocks", "memory", "calibration"],
                "required_calibration_assets": ["simulator_config"],
            },
        )
        metadata.write_text(
            json.dumps(
                {
                    "software": {
                        "os": "target-linux",
                        "kernel": "6.12",
                        "firmware": "opensbi",
                        "runtime": "simulator",
                        "build_id": "test-build",
                    },
                    "clocks": {
                        "source": "sim-counter",
                        "cpu_hz": 1,
                        "npu_hz": 1,
                        "memory_hz": 1,
                        "governor": "fixed",
                    },
                    "memory": {
                        "type": "sim-memory",
                        "capacity_bytes": 1,
                        "bandwidth_bytes_per_second": 1,
                        "channels": 1,
                    },
                    "calibration": {
                        "status": "calibrated",
                        "source": "simulator calibration record",
                        "ground_truth_reference": "simulator counter export",
                        "last_calibrated_utc": "2026-05-19T00:00:00Z",
                        "assets": {
                            "simulator_config": {
                                "status": "calibrated",
                                "source": str(metrics),
                                "sha256": "a" * 64,
                                "evidence": str(metrics),
                            }
                        },
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        result = run_runner(
            [
                "run",
                "--config",
                str(config),
                "--out-dir",
                str(out_dir),
                "--metadata",
                str(metadata),
                "--report-id",
                "uncalibrated-sim",
            ]
        )
        report = json.loads((out_dir / "uncalibrated-sim/report.json").read_text(encoding="utf-8"))
    if result.returncode != 1:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    if row.get("status") != "failed":
        raise AssertionError(json.dumps(row, indent=2))
    if "not calibrated benchmark evidence" not in row.get("error", ""):
        raise AssertionError(json.dumps(row, indent=2))


def test_calibrated_result_requires_utc_timestamp_and_sha256_assets() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        config = root / "config.json"
        out_dir = root / "out"
        metadata = root / "metadata.json"
        write_config(
            config,
            {
                "name": "fake_coremark",
                "suite": "CoreMark",
                "version": "test",
                "command": [sys.executable, "-c", "print('CoreMark/MHz : 1.0')"],
                "input_dataset": "synthetic",
                "primary_metric": "CoreMark/MHz",
                "units": "score_per_mhz",
                "parser": "coremark_v1",
                "required_metadata": ["software", "clocks", "memory", "calibration"],
                "required_metrics": ["coremark_per_mhz"],
                "required_calibration_assets": ["clock_source"],
            },
        )
        metadata.write_text(
            json.dumps(
                {
                    "software": {
                        "os": "target-linux",
                        "kernel": "6.12",
                        "firmware": "opensbi",
                        "runtime": "bare",
                        "build_id": "test-build",
                    },
                    "clocks": {
                        "source": "lab-counter",
                        "cpu_hz": 1,
                        "npu_hz": 1,
                        "memory_hz": 1,
                        "governor": "fixed",
                    },
                    "memory": {
                        "type": "lpddr",
                        "capacity_bytes": 1,
                        "bandwidth_bytes_per_second": 1,
                        "channels": 1,
                    },
                    "calibration": {
                        "status": "calibrated",
                        "source": "bench transcript",
                        "ground_truth_reference": "lab log",
                        "last_calibrated_utc": "2026-05-19 12:00:00",
                        "assets": {
                            "clock_source": {
                                "status": "calibrated",
                                "source": "counter",
                                "sha256": "not-a-real-digest",
                                "evidence": "lab-log",
                            }
                        },
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        result = run_runner(
            [
                "run",
                "--config",
                str(config),
                "--out-dir",
                str(out_dir),
                "--metadata",
                str(metadata),
                "--report-id",
                "bad-calibration-shape",
                "--strict-missing",
            ]
        )
        report = json.loads(
            (out_dir / "bad-calibration-shape/report.json").read_text(encoding="utf-8")
        )

    if result.returncode != 2:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    if row.get("status") != "blocked":
        raise AssertionError(json.dumps(row, indent=2))
    errors = "\n".join(
        f"{item.get('name')} {item.get('reason')}" for item in row.get("blocked_requirements", [])
    )
    for token in (
        "calibration.last_calibrated_utc invalid_calibration_timestamp",
        "calibration.assets.clock_source.sha256 invalid_calibration_asset_hash",
    ):
        if token not in errors:
            raise AssertionError(json.dumps(row, indent=2))


def test_metadata_blockers_reject_invalid_calibration_shapes() -> None:
    report = {
        "calibration": {
            "status": "calibrated",
            "source": "target run",
            "ground_truth_reference": "lab record",
            "last_calibrated_utc": "2026-05-19T12:00:00-07:00",
            "assets": {
                "clock_source": {
                    "status": "calibrated",
                    "source": "counter",
                    "sha256": "host-smoke",
                    "evidence": "lab-log",
                }
            },
        }
    }
    bench = {"required_metadata": ["calibration"], "required_calibration_assets": ["clock_source"]}

    import importlib.util

    spec = importlib.util.spec_from_file_location("run_benchmarks", RUNNER)
    if spec is None or spec.loader is None:
        raise AssertionError("could not import benchmark runner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    blockers = module.metadata_blockers(report, bench)
    reasons = {blocker.get("reason") for blocker in blockers}

    if "invalid_calibration_timestamp" not in reasons:
        raise AssertionError(json.dumps(blockers, indent=2))
    if "invalid_calibration_asset_hash" not in reasons:
        raise AssertionError(json.dumps(blockers, indent=2))


def test_local_host_smoke_metadata_blocks_release_runner() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        config = root / "config.json"
        out_dir = root / "out"
        write_config(
            config,
            {
                "name": "fake_coremark",
                "suite": "CoreMark",
                "version": "test",
                "command": [sys.executable, "-c", "print('CoreMark/MHz : 1.0')"],
                "input_dataset": "synthetic",
                "primary_metric": "CoreMark/MHz",
                "units": "score_per_mhz",
                "parser": "coremark_v1",
                "required_metadata": ["software", "clocks", "memory", "calibration"],
                "required_metrics": ["coremark_per_mhz"],
                "required_calibration_assets": ["clock_source"],
            },
        )
        result = run_runner(
            [
                "run",
                "--config",
                str(config),
                "--out-dir",
                str(out_dir),
                "--metadata",
                str(LOCAL_HOST_METADATA),
                "--report-id",
                "local-host-smoke-blocked",
                "--strict-missing",
            ]
        )
        report = json.loads(
            (out_dir / "local-host-smoke-blocked/report.json").read_text(encoding="utf-8")
        )

    if result.returncode != 2:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    if row.get("status") != "blocked":
        raise AssertionError(json.dumps(row, indent=2))
    reasons = {item.get("reason") for item in row.get("blocked_requirements", [])}
    if "blocked_metadata_field" not in reasons or "uncalibrated_asset" not in reasons:
        raise AssertionError(json.dumps(row, indent=2))


def main() -> int:
    for test in (
        test_parsed_metric_with_blocked_calibration_fails_schema,
        test_uncalibrated_simulator_metrics_fail_instead_of_passing,
        test_calibrated_result_requires_utc_timestamp_and_sha256_assets,
        test_metadata_blockers_reject_invalid_calibration_shapes,
        test_local_host_smoke_metadata_blocks_release_runner,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
