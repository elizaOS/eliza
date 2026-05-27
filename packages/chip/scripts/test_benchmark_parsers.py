#!/usr/bin/env python3
"""Regression tests for benchmark parser and strict-missing behavior."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "benchmarks/run_benchmarks.py"
PLAN_PATH = ROOT / "benchmarks/configs/benchmark_plan.json"
BLOCKED_METADATA = ROOT / "benchmarks/metadata/strict-blocked-template.json"
NNAPI_PROOF_CHECK = ROOT / "scripts/check_e1_npu_nnapi_proof.py"

spec = importlib.util.spec_from_file_location("run_benchmarks", RUNNER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {RUNNER_PATH}")
run_benchmarks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_benchmarks)


def run_runner(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER_PATH), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def assert_equal(actual: object, expected: object, message: str) -> None:
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def valid_l5_l6_report() -> dict[str, Any]:
    return {
        "schema": "eliza.benchmark_run.v1",
        "report_id": "l5-l6-target-test",
        "status": "passed",
        "date_utc": "2026-05-22T00:00:00+00:00",
        "dry_run": False,
        "claim_allowed": True,
        "phone_claim_allowed": True,
        "release_claim_allowed": False,
        "claim_level": "L5_PROTOTYPE_SILICON",
        "platform": {
            "name": "e1-phone-prototype",
            "revision": "evt",
            "source_tree_sha": "unknown",
            "host": "target",
            "host_system": "linux",
        },
        "target_execution": {
            "runner": "prototype",
            "transcript_sha256": "1" * 64,
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
            "cpu_hz": 1,
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
                "path": run_benchmarks.PROCESS_EFFECTS_CONTRACT_PATH,
                "sha256": run_benchmarks.sha256_file(
                    ROOT / run_benchmarks.PROCESS_EFFECTS_CONTRACT_PATH
                ),
            },
            "process_corner_count": 1,
            "worst_process_corner": "14a_tt",
            "pdk_signoff_claim": run_benchmarks.PROCESS_PDK_SIGNOFF_PASSED,
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
                    "sha256": "3" * 64,
                    "evidence": "clock transcript",
                }
            },
        },
        "config": {"version": "test", "benchmarks": []},
        "results": [
            {
                "name": "coremark",
                "suite": "CoreMark",
                "version": "test",
                "command": ["coremark"],
                "input_dataset": "default",
                "primary_metric": "CoreMark/MHz",
                "units": "score_per_mhz",
                "dependencies": [],
                "artifacts": {"raw_output": "coremark.log", "raw_output_sha256": "4" * 64},
                "status": "passed",
                "parser": "coremark_v1",
                "provenance": "measured",
                "metrics": {"coremark_per_mhz": 1.0},
                "target_execution": {
                    "runner": "prototype",
                    "transcript_sha256": "5" * 64,
                },
                "run_metadata": {
                    "required_metadata": [
                        "software",
                        "clocks",
                        "memory",
                        "thermal",
                        "power",
                        "process",
                        "calibration",
                    ],
                    "required_metrics": ["coremark_per_mhz"],
                    "metric_gates": [],
                    "required_calibration_assets": ["clock_source"],
                },
            }
        ],
    }


def test_suite_parsers_accept_real_formats() -> None:
    coremark = run_benchmarks.parse_coremark("Iterations/Sec   : 123.5\nCoreMark/MHz : 4.25\n")
    assert_equal(coremark["coremark_per_mhz"], 4.25, "CoreMark/MHz")

    stream = run_benchmarks.parse_stream("Copy: 10.0\nScale: 11.0\nAdd: 12.0\nTriad: 13.5\n")
    assert_equal(stream["triad_mb_per_s"], 13.5, "STREAM Triad")

    bw_mem = run_benchmarks.parse_lmbench_bw_mem("64.00 8192.25\n")
    assert_equal(bw_mem["bandwidth_mb_per_s"], 8192.25, "lmbench bandwidth")

    lat_mem = run_benchmarks.parse_lmbench_lat_mem_rd("0.00049 1.2\n64.0 98.5\n")
    assert_equal(lat_mem["max_latency_ns"], 98.5, "lmbench latency")

    fio = run_benchmarks.parse_fio_json(
        json.dumps({"jobs": [{"read": {"iops": 10, "bw": 2048}, "write": {"iops": 3, "bw": 512}}]})
    )
    assert_equal(fio["read_iops"], 10.0, "fio read iops")
    assert_equal(fio["write_bw_kib_s"], 512.0, "fio write bandwidth")

    tflite = run_benchmarks.parse_tflite_benchmark_model(
        "Inference timings in us: Init: 1, First inference: 2, Warmup (avg): 3, Inference (avg): 42.75\n"
        "CPU fallback: 0%\n"
        "unsupported ops: 0\n"
    )
    assert_equal(tflite["avg_latency_us"], 42.75, "TFLite avg latency")
    assert_equal(tflite["cpu_fallback_percent"], 0.0, "TFLite fallback")
    assert_equal(tflite["unsupported_op_count"], 0, "TFLite unsupported ops")


def test_parsers_reject_incomplete_or_comparable_metrics() -> None:
    rejects: list[tuple[str, Any, str]] = [
        ("coremark", run_benchmarks.parse_coremark, "Iterations/Sec : 123\n"),
        ("stream", run_benchmarks.parse_stream, "Copy: 1.0\n"),
        ("fio", run_benchmarks.parse_fio_json, json.dumps({"jobs": [{"read": {}, "write": {}}]})),
        ("tflite", run_benchmarks.parse_tflite_benchmark_model, "unsupported ops: 0\n"),
        (
            "simulator",
            run_benchmarks.parse_simulator_metrics,
            json.dumps(
                {
                    "target_cycles": 1,
                    "simulated_frequency_hz": 1,
                    "ipc": 1,
                    "benchmark_success_allowed": False,
                }
            ),
        ),
        (
            "simulator_score",
            run_benchmarks.parse_simulator_metrics,
            json.dumps(
                {
                    "target_cycles": 1,
                    "simulated_frequency_hz": 1,
                    "ipc": 1,
                    "benchmark_success_allowed": True,
                    "phone_score": 99,
                }
            ),
        ),
    ]
    for name, parser, output in rejects:
        try:
            parser(output)
        except (ValueError, json.JSONDecodeError):
            continue
        raise AssertionError(f"{name} parser unexpectedly accepted invalid evidence")


def test_simulator_parser_accepts_calibrated_counter_export_shape() -> None:
    metrics = run_benchmarks.parse_simulator_metrics(
        json.dumps(
            {
                "target_cycles": 1000,
                "simulated_frequency_hz": 500_000_000,
                "ipc": 0.5,
                "mpki": 2.0,
                "benchmark_success_allowed": True,
            }
        )
    )
    assert_equal(metrics["target_cycles"], 1000, "simulator cycles")
    assert_equal(metrics["benchmark_success_allowed"], True, "simulator success flag")


def test_simulator_benchmark_runs_without_measured_target_metadata() -> None:
    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_parent) as td:
        temp_root = Path(td)
        metrics = temp_root / "simulator-arch-metrics.json"
        metrics.write_text(
            json.dumps(
                {
                    "schema": "eliza.simulator_arch_metrics.v1",
                    "evidence_class": "deterministic_14a_cpu_ap_arch_model",
                    "claim_boundary": (
                        "modeled_architecture_metrics_only_not_pdk_rtl_silicon_or_phone_score_evidence"
                    ),
                    "benchmark_success_allowed": True,
                    "target_cycles": 1000,
                    "simulated_frequency_hz": 3_200_000_000,
                    "ipc": 1.8,
                    "process_corner_count": 4,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        config = temp_root / "benchmark_plan_simulator_only.json"
        config.write_text(
            json.dumps(
                {
                    "version": "test",
                    "benchmarks": [
                        {
                            "name": "simulator_arch_metrics",
                            "suite": "Eliza simulator metrics",
                            "version": "test",
                            "command": ["cat", str(metrics)],
                            "requires": ["cat"],
                            "input_dataset": "simulator metrics JSON",
                            "primary_metric": "target_cycles",
                            "units": "cycles",
                            "parser": "simulator_metrics_v1",
                            "provenance": "simulator",
                            "required_metrics": [
                                "target_cycles",
                                "simulated_frequency_hz",
                                "ipc",
                                "process_corner_count",
                            ],
                        }
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        out_dir = temp_root / "out"
        result = run_runner(
            [
                "run",
                "--config",
                str(config),
                "--out-dir",
                str(out_dir),
                "--report-id",
                "simulator-only",
            ]
        )
        report = json.loads((out_dir / "simulator-only/report.json").read_text(encoding="utf-8"))

    if result.returncode != 0:
        raise AssertionError(result.stdout)
    row = report["results"][0]
    assert_equal(row["status"], "passed", "simulator-only status")
    assert_equal(row["provenance"], "simulator", "simulator-only provenance")
    assert_equal(row["run_metadata"]["required_metadata"], [], "simulator required metadata")
    for section in ("software", "clocks", "memory", "thermal", "power", "process", "calibration"):
        if section in report:
            raise AssertionError(f"simulator-only report unexpectedly required {section}")


def test_npu_scale_parser_preserves_process_corner_metrics() -> None:
    result = subprocess.run(
        [
            "python3",
            str(ROOT / "benchmarks/sim/run_npu_scale_sim.py"),
            "--config",
            "open_2028_first_50tops",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    metrics = run_benchmarks.parse_eliza_npu_scale_sim(result.stdout)
    assert_equal(metrics["process_corner_count"], 4, "process corner count")
    if metrics["total_descriptors_required"] <= 0:
        raise AssertionError("NPU scale parser must preserve descriptor count")
    if metrics["max_descriptor_queue_passes"] <= 0:
        raise AssertionError("NPU scale parser must preserve queue pass count")
    if metrics["total_dma_beats"] <= 0:
        raise AssertionError("NPU scale parser must preserve DMA beat count")
    if metrics["worst_process_corner_min_observed_tops"] <= 0:
        raise AssertionError("worst process corner TOPS must be positive")


def test_mlperf_inference_parser_accepts_modeled_npu_output() -> None:
    result = subprocess.run(
        [
            "python3",
            str(ROOT / "benchmarks/mlperf/run_mlperf_inference.py"),
            "--query-count",
            "8",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)

    metrics = run_benchmarks.parse_eliza_mlperf_inference(result.stdout)

    assert_equal(metrics["benchmark_success_allowed"], True, "MLPerf benchmark success marker")
    assert_equal(metrics["scenario_count"], 2, "MLPerf scenario count")
    assert_equal(metrics["min_top1_accuracy"], 1.0, "MLPerf min accuracy")
    assert_equal(metrics["npu_macs_total"], 288, "MLPerf total MACs")
    assert_equal(metrics["npu_commands_total"], 32, "MLPerf total NPU commands")
    assert_equal(metrics["macs_per_inference"], 18, "MLPerf MACs per inference")
    if metrics["single_stream_p90_latency_ns"] <= 0:
        raise AssertionError("MLPerf SingleStream p90 latency must be positive")
    if metrics["offline_throughput_samples_per_second"] <= 0:
        raise AssertionError("MLPerf Offline throughput must be positive")
    if metrics["energy_joules_per_inference"] <= 0:
        raise AssertionError("MLPerf modeled energy must be positive")


def test_mlperf_inference_parser_rejects_claim_and_power_drift() -> None:
    result = subprocess.run(
        [
            "python3",
            str(ROOT / "benchmarks/mlperf/run_mlperf_inference.py"),
            "--query-count",
            "2",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    data = json.loads(result.stdout)

    wrong_claim = json.loads(json.dumps(data))
    wrong_claim["claim_boundary"] = "measured_power_official_submission"
    try:
        run_benchmarks.parse_eliza_mlperf_inference(json.dumps(wrong_claim))
    except ValueError as exc:
        if "claim boundary" not in str(exc):
            raise
    else:
        raise AssertionError("MLPerf parser accepted drifted claim boundary")

    missing_power_blocker = json.loads(json.dumps(data))
    missing_power_blocker["summary"]["blocked_axes"] = [
        blocker
        for blocker in missing_power_blocker["summary"]["blocked_axes"]
        if blocker.get("blocker_id") != "mlperf-power-closed"
    ]
    try:
        run_benchmarks.parse_eliza_mlperf_inference(json.dumps(missing_power_blocker))
    except ValueError as exc:
        if "measured-power blocker" not in str(exc):
            raise
    else:
        raise AssertionError("MLPerf parser accepted missing measured-power blocker")


def test_strict_missing_exits_two_and_preserves_blockers() -> None:
    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_parent) as td:
        temp_root = Path(td)
        temp_plan = temp_root / "benchmark_plan_missing_assets.json"
        plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
        for bench in plan["benchmarks"]:
            if bench["name"] == "coremark":
                bench["requires"] = ["definitely_missing_eliza_coremark"]
            for artifact in bench.get("model_artifacts", []):
                artifact["path"] = "benchmarks/models/definitely_missing_mobile_smoke.tflite"
        temp_plan.write_text(json.dumps(plan, indent=2), encoding="utf-8")
        out_dir = Path(td) / "out"
        result = run_runner(
            [
                "plan",
                "--config",
                str(temp_plan),
                "--out-dir",
                str(out_dir),
                "--strict-missing",
                "--report-id",
                "strict-missing",
            ]
        )
        report = json.loads((out_dir / "strict-missing/report.json").read_text(encoding="utf-8"))

    if result.returncode != 2:
        raise AssertionError(result.stdout)
    result_by_name = {row["name"]: row for row in report["results"]}
    assert_equal(
        result_by_name["coremark"]["status"], "planned_missing_deps", "coremark strict status"
    )
    assert_equal(result_by_name["tflite_cpu"]["status"], "blocked", "tflite strict status")
    blocked = result_by_name["tflite_cpu"].get("blocked_assets", [])
    if not blocked:
        raise AssertionError(json.dumps(result_by_name["tflite_cpu"], indent=2))
    assert_equal(blocked[0]["blocker_id"], "TFLITE_SMOKE_MODEL_MISSING", "tflite blocker id")
    assert_equal(blocked[0]["pipeline_visible"], True, "tflite pipeline visibility")
    assert_equal(blocked[0]["release_blocking"], True, "tflite release blocker")


def test_blocked_results_require_blocked_placeholder_provenance() -> None:
    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_parent) as td:
        report_id = "strict-release-gate-test"
        out_dir = Path(td) / "out"
        result = run_runner(
            [
                "run",
                "--metadata",
                str(BLOCKED_METADATA),
                "--strict-missing",
                "--report-id",
                report_id,
                "--out-dir",
                str(out_dir),
            ]
        )
        if result.returncode not in {1, 2}:
            raise AssertionError(result.stdout)
        baseline = json.loads((out_dir / report_id / "report.json").read_text(encoding="utf-8"))

    for provenance in ("measured", "target-measured", "silicon-measured", "imported"):
        report = json.loads(json.dumps(baseline))
        result = next(row for row in report["results"] if row["status"] == "blocked")
        result["provenance"] = provenance
        errors = run_benchmarks.validate_report(report)
        if not any("blocked result provenance must be blocked_placeholder" in e for e in errors):
            raise AssertionError((provenance, errors))


def test_l5_l6_passed_results_require_target_execution() -> None:
    report = valid_l5_l6_report()
    errors = run_benchmarks.validate_report(report)
    if errors:
        raise AssertionError(errors)

    missing_report_target = json.loads(json.dumps(report))
    del missing_report_target["target_execution"]
    errors = run_benchmarks.validate_report(missing_report_target)
    if not any("report missing target_execution" in error for error in errors):
        raise AssertionError(errors)

    missing_result_target = json.loads(json.dumps(report))
    del missing_result_target["results"][0]["target_execution"]
    errors = run_benchmarks.validate_report(missing_result_target)
    if not any("report.results[0] missing target_execution" in error for error in errors):
        raise AssertionError(errors)


def test_l5_l6_blocked_report_does_not_require_target_execution() -> None:
    report = valid_l5_l6_report()
    del report["target_execution"]
    report["status"] = "blocked"
    report["claim_allowed"] = False
    report["phone_claim_allowed"] = False
    report["release_claim_allowed"] = False
    result = report["results"][0]
    result.pop("target_execution")
    result.pop("metrics")
    result.pop("run_metadata")
    result["status"] = "blocked"
    result["provenance"] = "blocked_placeholder"
    result["blocked_requirements"] = [
        {
            "name": "target.runner",
            "reason": "missing target evidence",
            "resolution": "Run on an L5/L6 target and archive the target transcript.",
        }
    ]

    errors = run_benchmarks.validate_report(report)
    if errors:
        raise AssertionError(errors)


def test_report_status_and_claim_flags_match_results() -> None:
    report = valid_l5_l6_report()

    missing_status = json.loads(json.dumps(report))
    missing_status.pop("status")
    errors = run_benchmarks.validate_report(missing_status)
    if not any("report missing status" in error for error in errors):
        raise AssertionError(errors)

    empty_results = json.loads(json.dumps(report))
    empty_results["results"] = []
    errors = run_benchmarks.validate_report(empty_results)
    if not any("results must contain at least one benchmark result" in error for error in errors):
        raise AssertionError(errors)

    blocked_result = json.loads(json.dumps(report))
    result = blocked_result["results"][0]
    result["status"] = "blocked"
    result["provenance"] = "blocked_placeholder"
    result.pop("metrics", None)
    result.pop("run_metadata", None)
    result["blocked_requirements"] = [
        {
            "name": "target.runner",
            "reason": "missing target evidence",
            "resolution": "Run on an L5/L6 target and archive the target transcript.",
        }
    ]
    errors = run_benchmarks.validate_report(blocked_result)
    if not any("report.status must be blocked" in error for error in errors):
        raise AssertionError(errors)

    blocked_result["status"] = "blocked"
    blocked_result["claim_allowed"] = False
    blocked_result["phone_claim_allowed"] = False
    blocked_result["release_claim_allowed"] = False
    errors = run_benchmarks.validate_report(blocked_result)
    if errors:
        raise AssertionError(errors)

    dry_run = json.loads(json.dumps(report))
    dry_run["dry_run"] = True
    dry_run["claim_allowed"] = True
    dry_run["phone_claim_allowed"] = True
    dry_run["release_claim_allowed"] = False
    dry_run["results"][0]["status"] = "planned"
    dry_run["results"][0]["provenance"] = "dry_run"
    dry_run["results"][0].pop("metrics", None)
    dry_run["results"][0].pop("run_metadata", None)
    errors = run_benchmarks.validate_report(dry_run)
    if not any("claim_allowed must match passed real-run status" in error for error in errors):
        raise AssertionError(errors)


def test_blocked_requirements_require_shape() -> None:
    report = valid_l5_l6_report()
    result = report["results"][0]
    result["status"] = "blocked"
    result["provenance"] = "blocked_placeholder"
    result.pop("metrics", None)
    result.pop("run_metadata", None)
    result["blocked_requirements"] = [{"name": "target.runner", "reason": ""}]

    errors = run_benchmarks.validate_report(report)
    if not any("blocked_requirements[0].reason" in error for error in errors):
        raise AssertionError(errors)
    if not any("blocked_requirements[0].resolution" in error for error in errors):
        raise AssertionError(errors)


def test_blocked_metadata_template_covers_config_assets() -> None:
    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    metadata = json.loads(BLOCKED_METADATA.read_text(encoding="utf-8"))
    if "process" not in metadata:
        raise AssertionError("blocked metadata template missing process section")
    process = metadata["process"]
    assert_equal(
        process.get("process_effects_contract", {}).get("path"),
        "docs/spec-db/process-14a-effects.yaml",
        "process effects contract path",
    )
    if process.get("pdk_signoff_claim") != "blocked-no-pdk-signoff":
        raise AssertionError("blocked metadata template must keep PDK signoff blocked")
    for bench in plan["benchmarks"]:
        if bench.get("provenance") != "simulator":
            required_metadata = set(bench.get("required_metadata", []))
            if "process" not in required_metadata:
                raise AssertionError(f"{bench['name']} missing required process metadata")
    assets = metadata["calibration"]["assets"]
    expected_assets = sorted(
        {
            asset
            for bench in plan["benchmarks"]
            for asset in bench.get("required_calibration_assets", [])
        }
    )
    missing = [asset for asset in expected_assets if asset not in assets]
    if missing:
        raise AssertionError("blocked metadata template missing asset(s): " + ", ".join(missing))
    for asset_name in expected_assets:
        asset = assets[asset_name]
        assert_equal(asset.get("status"), "blocked", f"{asset_name} status")
        for field in ("source", "sha256", "evidence"):
            value = asset.get(field)
            if not isinstance(value, str) or not value.startswith("blocked-"):
                raise AssertionError(f"{asset_name}.{field} must be a blocked marker")


def test_process_metadata_blocks_without_pdk_signoff() -> None:
    report = {
        "process": {
            "node": "14A",
            "pdk": "pre-pdk-model",
            "process_effects_contract": {
                "path": "docs/spec-db/process-14a-effects.yaml",
                "sha256": "a" * 64,
            },
            "process_corner_count": 4,
            "worst_process_corner": "14a_ss_0p63v_105c_frontside_pdn",
            "pdk_signoff_claim": "none",
        },
        "calibration": {"status": "calibrated", "assets": {}},
    }
    bench = {"required_metadata": ["process"], "required_calibration_assets": []}

    blockers = run_benchmarks.metadata_blockers(report, bench)

    if not any(blocker.get("reason") == "missing_pdk_signoff" for blocker in blockers):
        raise AssertionError(json.dumps(blockers, indent=2))


def test_e1_npu_nnapi_proof_check_preserves_missing_proof_blocker() -> None:
    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_parent) as td:
        temp_root = Path(td)
        temp_plan = temp_root / "benchmark_plan_missing_nnapi_proof.json"
        plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
        for bench in plan["benchmarks"]:
            if bench["name"] == "tflite_e1_npu":
                bench["capability_artifacts"][0]["path"] = (
                    "benchmarks/capabilities/definitely_missing_e1_npu_nnapi.proof.json"
                )
        temp_plan.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
        status_path = Path(td) / "status.json"
        result = subprocess.run(
            [
                "python3",
                str(NNAPI_PROOF_CHECK),
                "--config",
                str(temp_plan),
                "--status-json",
                str(status_path),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        status = json.loads(status_path.read_text(encoding="utf-8"))

    if result.returncode != 2:
        raise AssertionError(result.stdout)
    assert_equal(status["status"], "blocked", "proof readiness status")
    assert_equal(status["can_generate_locally"], False, "local proof generation")
    blockers = status.get("local_blockers", [])
    if not any(
        blocker.get("blocked_reason") == "missing_e1_npu_nnapi_accelerator" for blocker in blockers
    ):
        raise AssertionError(json.dumps(status, indent=2))
    findings = status.get("findings", [])
    if not any(
        finding.get("code") == "e1_npu_nnapi_e1_npu_nnapi_accelerator_missing"
        for finding in findings
    ):
        raise AssertionError(json.dumps(status, indent=2))


def test_e1_npu_nnapi_proof_rejects_tops_and_capture_command_drift() -> None:
    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    bench = next(item for item in plan["benchmarks"] if item["name"] == "tflite_e1_npu")
    artifact = dict(bench["capability_artifacts"][0])
    model_path = ROOT / "benchmarks/models/mobile_smoke.tflite"

    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temp_parent) as td:
        temp_root = Path(td)
        evidence_dir = temp_root / "evidence"
        evidence_dir.mkdir()
        transcripts = {
            "adb_devices": evidence_dir / "adb-devices.log",
            "nnapi_accelerator_query": evidence_dir / "nnapi-query.log",
            "benchmark_model_nnapi": evidence_dir / "benchmark-model.log",
            "dma_trace": evidence_dir / "dma-trace.log",
        }
        transcripts["adb_devices"].write_text("List of devices attached\nabc\tdevice\n")
        transcripts["nnapi_accelerator_query"].write_text("e1-npu\n")
        transcripts["benchmark_model_nnapi"].write_text(
            "--use_nnapi=true --nnapi_accelerator_name=e1-npu NNAPI\n"
        )
        transcripts["dma_trace"].write_text("e1-npu DMA bytes_read bytes_written\n")

        proof_path = temp_root / "e1_npu_nnapi.proof.json"
        proof = {
            "schema": "eliza.e1_npu_nnapi_capability.v1",
            "date_utc": "2026-05-18T00:00:00+00:00",
            "target": "test-target",
            "generated_by": "unit-test",
            "accelerator_name": "e1-npu",
            "capability": {
                "claim_level": "L4_DEV_BOARD",
                "precision": "int8",
            },
            "nnapi": {
                "accelerator_name": "e1-npu",
                "delegated_node_count": 1,
                "total_node_count": 1,
                "cpu_fallback_percent": 0,
                "unsupported_op_count": 0,
            },
            "dataflow": {"name": "measured-test-path"},
            "dma": {
                "path": "hardware_dma",
                "bytes_read": 1,
                "bytes_written": 1,
                "trace_bytes": transcripts["dma_trace"].stat().st_size,
            },
            "measurements": {
                "macs_per_inference": 1000,
                "npu_cycles": 1000,
                "npu_hz": 1_000_000_000,
                "observed_tops": 0.01,
                "tops_formula": "observed_tops = macs_per_inference * 2 / (npu_cycles / npu_hz) / 1e12",
            },
            "capture": {
                "commands": {
                    **run_benchmarks.E1_NPU_REQUIRED_CAPTURE_COMMANDS,
                    "benchmark_model_nnapi": "benchmark_model --wrong",
                }
            },
            "model_artifacts": {
                "benchmarks/models/mobile_smoke.tflite": {
                    "sha256": run_benchmarks.sha256_file(model_path)
                }
            },
            "transcripts": {
                name: {
                    "path": str(path.relative_to(ROOT)),
                    "sha256": run_benchmarks.sha256_file(path),
                    "bytes": path.stat().st_size,
                }
                for name, path in transcripts.items()
            },
        }
        proof_path.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
        artifact["path"] = str(proof_path)
        status = run_benchmarks.capability_artifact_status(artifact, ROOT)

    assert_equal(status["available"], False, "drifted proof availability")
    errors = "\n".join(status.get("errors", []))
    if "observed_tops must match" not in errors:
        raise AssertionError(errors)
    if "capture.commands.benchmark_model_nnapi" not in errors:
        raise AssertionError(errors)


def main() -> int:
    for test in (
        test_suite_parsers_accept_real_formats,
        test_parsers_reject_incomplete_or_comparable_metrics,
        test_simulator_parser_accepts_calibrated_counter_export_shape,
        test_simulator_benchmark_runs_without_measured_target_metadata,
        test_npu_scale_parser_preserves_process_corner_metrics,
        test_mlperf_inference_parser_accepts_modeled_npu_output,
        test_mlperf_inference_parser_rejects_claim_and_power_drift,
        test_strict_missing_exits_two_and_preserves_blockers,
        test_blocked_results_require_blocked_placeholder_provenance,
        test_l5_l6_passed_results_require_target_execution,
        test_l5_l6_blocked_report_does_not_require_target_execution,
        test_report_status_and_claim_flags_match_results,
        test_blocked_requirements_require_shape,
        test_blocked_metadata_template_covers_config_assets,
        test_process_metadata_blocks_without_pdk_signoff,
        test_e1_npu_nnapi_proof_check_preserves_missing_proof_blocker,
        test_e1_npu_nnapi_proof_rejects_tops_and_capture_command_drift,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
