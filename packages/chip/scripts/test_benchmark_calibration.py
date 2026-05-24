#!/usr/bin/env python3
"""Regression tests for benchmark calibration fail-closed behavior."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "benchmarks/run_benchmarks.py"
BLOCKED_METADATA = ROOT / "benchmarks/metadata/strict-blocked-template.json"
LOCAL_HOST_METADATA = ROOT / "benchmarks/metadata/local-host-smoke.json"
spec = importlib.util.spec_from_file_location("run_benchmarks", RUNNER)
bench = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(bench)


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


def test_target_measured_l5_l6_report_provenance_validates() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        evidence = root / "clock.txt"
        evidence.write_text("clock calibration\n", encoding="utf-8")
        transcript = root / "target-session.log"
        transcript.write_text("target benchmark session\n", encoding="utf-8")
        raw_output = root / "coremark.log"
        raw_output.write_text("CoreMark/MHz: 1.0\n", encoding="utf-8")
        process_contract = root / "docs/spec-db/process-14a-effects.yaml"
        process_contract.parent.mkdir(parents=True, exist_ok=True)
        process_contract.write_text("process effects contract fixture\n", encoding="utf-8")
        report = {
            "schema": "eliza.benchmark_run.v1",
            "report_id": "target-measured-l5",
            "status": "passed",
            "date_utc": "2026-05-23T00:00:00Z",
            "dry_run": False,
            "claim_allowed": True,
            "phone_claim_allowed": True,
            "release_claim_allowed": False,
            "claim_level": "L5_PROTOTYPE_SILICON",
            "platform": {
                "name": "e1-phone-prototype",
                "revision": "rev-a",
                "source_tree_sha": "abc123",
                "host": "host",
                "host_system": "linux",
            },
            "config": {"path": "test", "version": "test"},
            "target_execution": {
                "runner": "phone",
                "transcript_path": "target-session.log",
                "transcript_sha256": bench.sha256_file(transcript),
            },
            "software": {
                "os": "android",
                "kernel": "6.12",
                "firmware": "opensbi",
                "runtime": "native",
                "build_id": "build-1",
            },
            "clocks": {
                "source": "counter",
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
            "thermal": {
                "ambient_c": 25,
                "die_c": 35,
                "cooling": "passive",
                "throttle_state": "none",
            },
            "power": {
                "source": "meter",
                "watts": 1,
                "measurement_method": "inline",
                "sample_count": 1,
                "averaging_window_seconds": 1,
            },
            "process": {
                "node": "14A",
                "pdk": "pdk",
                "process_effects_contract": {
                    "path": "docs/spec-db/process-14a-effects.yaml",
                    "sha256": bench.sha256_file(process_contract),
                },
                "process_corner_count": 1,
                "worst_process_corner": "14a_ss_0p63v_105c",
                "pdk_signoff_claim": "pdk_extracted_timing_power_thermal_signoff_passed",
            },
            "calibration": {
                "status": "calibrated",
                "source": "lab",
                "ground_truth_reference": "meter",
                "last_calibrated_utc": "2026-05-23T00:00:00Z",
                "assets": {
                    "clock_source": {
                        "status": "calibrated",
                        "source": "lab",
                        "sha256": bench.sha256_file(evidence),
                        "evidence": "clock.txt",
                    }
                },
            },
            "results": [
                {
                    "name": "coremark",
                    "suite": "CoreMark",
                    "version": "1.0",
                    "command": ["coremark"],
                    "input_dataset": "native",
                    "primary_metric": "CoreMark/MHz",
                    "units": "score_per_mhz",
                    "dependencies": [],
                    "artifacts": {
                        "raw_output": "coremark.log",
                        "raw_output_sha256": bench.sha256_file(raw_output),
                    },
                    "status": "passed",
                    "provenance": "target-measured",
                    "parser": "coremark_v1",
                    "metrics": {"coremark_per_mhz": 1.0},
                    "run_metadata": {
                        "runs": 1,
                        "warmup_runs": 0,
                        "required_metadata": ["software", "clocks", "memory", "calibration"],
                        "required_metrics": ["coremark_per_mhz"],
                        "metric_gates": [],
                        "required_calibration_assets": ["clock_source"],
                    },
                    "target_execution": {
                        "runner": "phone",
                        "transcript_sha256": bench.sha256_file(raw_output),
                    },
                }
            ],
        }
        errors = bench.validate_report(report, artifact_root=root)
        drifted = json.loads(json.dumps(report))
        drifted["results"][0]["artifacts"]["raw_output_sha256"] = "d" * 64
        drift_errors = bench.validate_report(drifted, artifact_root=root)
        outside = root.parent / "outside-coremark.log"
        outside.write_text("CoreMark/MHz: 2.0\n", encoding="utf-8")
        raw_symlink = root / "linked-coremark.log"
        raw_symlink.symlink_to(outside)
        symlinked = json.loads(json.dumps(report))
        symlinked["results"][0]["artifacts"]["raw_output"] = "linked-coremark.log"
        symlinked["results"][0]["artifacts"]["raw_output_sha256"] = bench.sha256_file(outside)
        symlink_errors = bench.validate_report(symlinked, artifact_root=root)
        empty_transcript = root / "empty-target-session.log"
        empty_transcript.write_text("", encoding="utf-8")
        empty_top = json.loads(json.dumps(report))
        empty_top["target_execution"]["transcript_path"] = "empty-target-session.log"
        empty_top["target_execution"]["transcript_sha256"] = bench.sha256_file(empty_transcript)
        empty_errors = bench.validate_report(empty_top, artifact_root=root)
    if errors:
        raise AssertionError(errors)
    if not any("raw_output_sha256 does not match raw_output" in error for error in drift_errors):
        raise AssertionError(drift_errors)
    if not any(
        "artifacts.raw_output must resolve under artifact root" in error for error in symlink_errors
    ):
        raise AssertionError(symlink_errors)
    if not any(
        "target_execution.transcript_path must not be empty" in error for error in empty_errors
    ):
        raise AssertionError(empty_errors)
    print("PASS target-measured L5/L6 provenance validates")


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


def test_l5_l6_calibration_evidence_must_be_archived_under_chip() -> None:
    with tempfile.TemporaryDirectory() as td:
        temp_root = Path(td)
        config = temp_root / "config.json"
        out_dir = temp_root / "out"
        evidence = temp_root / "clock-source.txt"
        evidence.write_text("clock calibration transcript\n", encoding="utf-8")
        digest = __import__("hashlib").sha256(evidence.read_bytes()).hexdigest()
        metadata = temp_root / "metadata.json"
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
                        "last_calibrated_utc": "2026-05-19T12:00:00Z",
                        "assets": {
                            "clock_source": {
                                "status": "calibrated",
                                "source": "counter",
                                "sha256": digest,
                                "evidence": str(evidence),
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
                "--claim-level",
                "L5_PROTOTYPE_SILICON",
                "--report-id",
                "l5-evidence-outside-chip",
                "--strict-missing",
            ]
        )
        report = json.loads(
            (out_dir / "l5-evidence-outside-chip/report.json").read_text(encoding="utf-8")
        )

    if result.returncode != 2:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    reasons = {item.get("reason") for item in row.get("blocked_requirements", [])}
    if "evidence_outside_repo" not in reasons:
        raise AssertionError(json.dumps(row, indent=2))


def main() -> int:
    for test in (
        test_target_measured_l5_l6_report_provenance_validates,
        test_parsed_metric_with_blocked_calibration_fails_schema,
        test_uncalibrated_simulator_metrics_fail_instead_of_passing,
        test_calibrated_result_requires_utc_timestamp_and_sha256_assets,
        test_metadata_blockers_reject_invalid_calibration_shapes,
        test_local_host_smoke_metadata_blocks_release_runner,
        test_l5_l6_calibration_evidence_must_be_archived_under_chip,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
