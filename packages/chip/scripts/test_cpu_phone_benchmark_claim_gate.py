#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_cpu_phone_benchmark_claim_gate.py"
CLOCK_EVIDENCE_TEXT = "clock calibration evidence transcript\n"
POWER_EVIDENCE_TEXT = "power calibration evidence transcript\n"
LMBENCH_BINARY_EVIDENCE_TEXT = "lmbench binary build provenance\n"
COREMARK_BINARY_EVIDENCE_TEXT = "coremark binary build provenance\n"
DHRYSTONE_BINARY_EVIDENCE_TEXT = "dhrystone binary build provenance\n"
JETSTREAM_ENGINE_EVIDENCE_TEXT = "jetstream engine build provenance\n"
MEMORY_MODEL_EVIDENCE_TEXT = "memory model manifest\n"
PROCESS_CONTRACT_TEXT = "process effects contract fixture\n"
REPORT_TRANSCRIPT_TEXT = "top-level benchmark target session transcript\n"
CLOCK_EVIDENCE_SHA = hashlib.sha256(CLOCK_EVIDENCE_TEXT.encode("utf-8")).hexdigest()
POWER_EVIDENCE_SHA = hashlib.sha256(POWER_EVIDENCE_TEXT.encode("utf-8")).hexdigest()
LMBENCH_BINARY_EVIDENCE_SHA = hashlib.sha256(
    LMBENCH_BINARY_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
COREMARK_BINARY_EVIDENCE_SHA = hashlib.sha256(
    COREMARK_BINARY_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
DHRYSTONE_BINARY_EVIDENCE_SHA = hashlib.sha256(
    DHRYSTONE_BINARY_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
JETSTREAM_ENGINE_EVIDENCE_SHA = hashlib.sha256(
    JETSTREAM_ENGINE_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
MEMORY_MODEL_EVIDENCE_SHA = hashlib.sha256(MEMORY_MODEL_EVIDENCE_TEXT.encode("utf-8")).hexdigest()
PROCESS_CONTRACT_SHA = hashlib.sha256(PROCESS_CONTRACT_TEXT.encode("utf-8")).hexdigest()
REPORT_TRANSCRIPT_SHA = hashlib.sha256(REPORT_TRANSCRIPT_TEXT.encode("utf-8")).hexdigest()
SPEC_CONFIG_TEXT = "fake SPEC config fixture\n"
SPEC_CONFIG_SHA = hashlib.sha256(SPEC_CONFIG_TEXT.encode("utf-8")).hexdigest()

spec = importlib.util.spec_from_file_location("check_cpu_phone_benchmark_claim_gate", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
gate: Any = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def target_metadata_payload() -> dict[str, Any]:
    return {
        "target": "prototype",
        "software": {
            "os": "linux",
            "kernel": "test",
            "firmware": "test",
            "runtime": "target-shell",
            "build_id": "test-build",
        },
        "clocks": {
            "source": "calibrated_counter",
            "cpu_hz": 1000000000,
            "governor": "performance",
        },
        "memory": {
            "type": "lpddr5x",
            "capacity_bytes": 8589934592,
            "bandwidth_bytes_per_second": 120000000000,
            "channels": 4,
        },
        "power": {
            "source": "meter",
            "watts": 1.0,
            "measurement_method": "shunt",
            "sample_count": 16,
            "averaging_window_seconds": 10.0,
        },
        "thermal": {
            "ambient_c": 25,
            "die_c": 40,
            "cooling": "passive",
            "throttle_state": "none",
        },
        "process": {
            "node": "prototype",
            "pdk": "prototype",
            "process_effects_contract": {
                "path": "docs/spec-db/process-14a-effects.yaml",
                "sha256": PROCESS_CONTRACT_SHA,
            },
            "process_corner_count": 1,
            "worst_process_corner": "prototype_tt",
            "pdk_signoff_claim": "prototype-measured-not-release-signoff",
        },
        "calibration": {
            "status": "calibrated",
            "source": "lab",
            "ground_truth_reference": "calibrated instruments",
            "last_calibrated_utc": "2026-05-22T00:00:00Z",
            "assets": {
                "clock_source": {
                    "status": "calibrated",
                    "source": "clock transcript",
                    "sha256": CLOCK_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/clock-source.txt",
                },
                "power_meter": {
                    "status": "calibrated",
                    "source": "power transcript",
                    "sha256": POWER_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/power-meter.txt",
                },
                "lmbench_binary": {
                    "status": "calibrated",
                    "source": "build transcript",
                    "sha256": LMBENCH_BINARY_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/lmbench-binary.txt",
                },
                "coremark_binary": {
                    "status": "calibrated",
                    "source": "build transcript",
                    "sha256": COREMARK_BINARY_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/coremark-binary.txt",
                },
                "dhrystone_binary": {
                    "status": "calibrated",
                    "source": "build transcript",
                    "sha256": DHRYSTONE_BINARY_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/dhrystone-binary.txt",
                },
                "jetstream_engine": {
                    "status": "calibrated",
                    "source": "build transcript",
                    "sha256": JETSTREAM_ENGINE_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/jetstream-engine.txt",
                },
                "memory_model": {
                    "status": "calibrated",
                    "source": "board manifest",
                    "sha256": MEMORY_MODEL_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/memory-model.txt",
                },
            },
        },
    }


def target_metadata_text() -> str:
    return json.dumps(target_metadata_payload(), indent=2) + "\n"


def target_metadata_sha256() -> str:
    return hashlib.sha256(target_metadata_text().encode("utf-8")).hexdigest()


def write_calibration_evidence(root: Path) -> None:
    clock = root / "docs/evidence/calibration/clock-source.txt"
    power = root / "docs/evidence/calibration/power-meter.txt"
    lmbench_binary = root / "docs/evidence/calibration/lmbench-binary.txt"
    coremark_binary = root / "docs/evidence/calibration/coremark-binary.txt"
    dhrystone_binary = root / "docs/evidence/calibration/dhrystone-binary.txt"
    jetstream_engine = root / "docs/evidence/calibration/jetstream-engine.txt"
    memory_model = root / "docs/evidence/calibration/memory-model.txt"
    process_contract = root / "docs/spec-db/process-14a-effects.yaml"
    clock.parent.mkdir(parents=True, exist_ok=True)
    clock.write_text(CLOCK_EVIDENCE_TEXT, encoding="utf-8")
    power.write_text(POWER_EVIDENCE_TEXT, encoding="utf-8")
    lmbench_binary.write_text(LMBENCH_BINARY_EVIDENCE_TEXT, encoding="utf-8")
    coremark_binary.write_text(COREMARK_BINARY_EVIDENCE_TEXT, encoding="utf-8")
    dhrystone_binary.write_text(DHRYSTONE_BINARY_EVIDENCE_TEXT, encoding="utf-8")
    jetstream_engine.write_text(JETSTREAM_ENGINE_EVIDENCE_TEXT, encoding="utf-8")
    memory_model.write_text(MEMORY_MODEL_EVIDENCE_TEXT, encoding="utf-8")
    process_contract.parent.mkdir(parents=True, exist_ok=True)
    process_contract.write_text(PROCESS_CONTRACT_TEXT, encoding="utf-8")


def raw_output_text(name: str) -> str:
    return {
        "spec_cpu2017": (
            "SPEC CPU2017 runcpu result\n"
            "runcpu --config=e1.cfg --reportable --tune=base\n"
            "Reportable base run\n"
            "SPECint2017_rate_base: 9.1\n"
            "SPECint2017_speed_base: 7.2\n"
            "SPECfp2017_rate_base: 7.0\n"
            "SPECfp2017_speed_base: 6.8\n"
        ),
        "coremark": (
            "CoreMark target run\n"
            "CoreMark Size    : 666\n"
            "Correct operation validated\n"
            "Iterations/Sec: 12345.67\n"
            "CoreMark/MHz: 8.9\n"
        ),
        "dhrystone": "Dhrystone Benchmark target run\nDhrystones per Second: 987654.0\nDMIPS/MHz: 3.21\n",
        "jetstream2": "BrowserBench JetStream 2.2 target run\nJetStream 2 Score: 271.5\n",
    }[name]


def raw_output_sha256(name: str) -> str:
    return hashlib.sha256(raw_output_text(name).encode("utf-8")).hexdigest()


def spec_run_manifest_text() -> str:
    return (
        json.dumps(
            {
                "schema": "eliza.spec_cpu2017_run_manifest.v1",
                "spec_version": "SPEC CPU2017 v1.1.9",
                "runcpu_command": "runcpu --config=e1.cfg --reportable --tune=base",
                "config": "benchmarks/results/cpu/spec/e1.cfg",
                "config_sha256": SPEC_CONFIG_SHA,
                "reportable": True,
                "result_bundle": "spec_cpu2017.log",
                "result_bundle_sha256": raw_output_sha256("spec_cpu2017"),
            },
            indent=2,
        )
        + "\n"
    )


def spec_run_manifest_sha256() -> str:
    return hashlib.sha256(spec_run_manifest_text().encode("utf-8")).hexdigest()


def lmbench_raw_output_text(name: str) -> str:
    return {
        "lmbench_bw_mem": "bw_mem 64M rd\n64.00 1.00\n",
        "lmbench_lat_mem_rd": "lat_mem_rd 64M 128\n0.00049 1.00\n",
    }[name]


def lmbench_raw_output_sha256(name: str) -> str:
    return hashlib.sha256(lmbench_raw_output_text(name).encode("utf-8")).hexdigest()


def side_result(name: str, status: str = "passed") -> dict[str, Any]:
    benchmark = gate.EXPECTED_SIDE_BENCHMARK_FIELD.get(name, name)
    metrics_by_name = {
        "spec_cpu2017": {
            "specint2017_rate_base": 9.1,
            "specint2017_speed_base": 7.2,
            "specfp2017_rate_base": 7.0,
            "specfp2017_speed_base": 6.8,
        },
        "coremark": {"iterations_per_second": 12345.67, "coremark_per_mhz": 8.9},
        "dhrystone": {"dhrystones_per_second": 987654.0, "dmips_per_mhz": 3.21},
        "jetstream2": {"jetstream2_score": 271.5},
    }
    payload: dict[str, Any] = {
        "schema": gate.REQUIRED_SIDE_SCHEMA,
        "benchmark": benchmark,
        "status": status,
        "result_recorded_at": "2026-05-22T00:00:00Z",
        "manifest": f"benchmarks/cpu/{name}/manifest.json",
    }
    if status == "passed":
        payload.update(
            {
                "claim_level": "L5_PROTOTYPE_SILICON",
                "provenance": "measured",
                "metrics": metrics_by_name[name],
                "artifacts": {
                    "raw_output": f"{name}.log",
                    "raw_output_sha256": raw_output_sha256(name),
                    "target_metadata": f"benchmarks/metadata/{name}-target.json",
                    "target_metadata_sha256": target_metadata_sha256(),
                },
                "target_execution": {
                    "runner": "prototype",
                    "transcript_sha256": raw_output_sha256(name),
                },
            }
        )
        if name == "spec_cpu2017":
            payload["artifacts"]["spec_license_sha256"] = "1234567890abcdef" * 4
            payload["artifacts"]["spec_run_manifest"] = (
                "benchmarks/results/cpu/spec/run-manifest.json"
            )
            payload["artifacts"]["spec_run_manifest_sha256"] = spec_run_manifest_sha256()
    elif status == "blocked":
        blocked_requirements = [
            {
                "name": requirement,
                "reason": f"{requirement} missing test evidence",
                "resolution": f"Provide {requirement} evidence and rerun the harness.",
            }
            for requirement in sorted(gate.REQUIRED_BLOCKED_SIDE_REQUIREMENTS[name])
        ]
        payload.update(
            {
                "provenance": gate.REQUIRED_BLOCKED_SIDE_PROVENANCE,
                "claim_allowed": False,
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "reason": "blocked test side result",
                "blocked_requirements": blocked_requirements,
            }
        )
    return payload


def valid_benchmark_report() -> dict[str, Any]:
    process_sha = PROCESS_CONTRACT_SHA
    return {
        "schema": "eliza.benchmark_run.v1",
        "report_id": "cpu-phone-test",
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
            "transcript_path": "benchmarks/results/cpu-phone/target-session.log",
            "transcript_sha256": REPORT_TRANSCRIPT_SHA,
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
                    "sha256": CLOCK_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/clock-source.txt",
                },
                "power_meter": {
                    "status": "calibrated",
                    "source": "lab",
                    "sha256": POWER_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/power-meter.txt",
                },
                "lmbench_binary": {
                    "status": "calibrated",
                    "source": "build",
                    "sha256": LMBENCH_BINARY_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/lmbench-binary.txt",
                },
                "memory_model": {
                    "status": "calibrated",
                    "source": "board",
                    "sha256": MEMORY_MODEL_EVIDENCE_SHA,
                    "evidence": "docs/evidence/calibration/memory-model.txt",
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
                "artifacts": {
                    "raw_output": "bw.log",
                    "raw_output_sha256": lmbench_raw_output_sha256("lmbench_bw_mem"),
                    "target_metadata": "benchmarks/metadata/lmbench-target.json",
                    "target_metadata_sha256": target_metadata_sha256(),
                },
                "status": "passed",
                "parser": "lmbench_bw_mem",
                "provenance": "measured",
                "metrics": {"bandwidth_mb_per_s": 1.0},
                "target_execution": {
                    "runner": "prototype",
                    "transcript_sha256": lmbench_raw_output_sha256("lmbench_bw_mem"),
                },
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
                "artifacts": {
                    "raw_output": "lat.log",
                    "raw_output_sha256": lmbench_raw_output_sha256("lmbench_lat_mem_rd"),
                    "target_metadata": "benchmarks/metadata/lmbench-target.json",
                    "target_metadata_sha256": target_metadata_sha256(),
                },
                "status": "passed",
                "parser": "lmbench_lat_mem_rd",
                "provenance": "measured",
                "metrics": {"max_latency_ns": 1.0},
                "target_execution": {
                    "runner": "prototype",
                    "transcript_sha256": lmbench_raw_output_sha256("lmbench_lat_mem_rd"),
                },
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
    gate.load_benchmark_runner().ROOT = root
    gate.OUT = root / "build/reports/cpu_phone_benchmark_claim_gate.json"
    gate.L5_L6_OUT = root / "build/reports/cpu_phone_l5_l6_benchmark_report.json"
    gate.DEFAULT_REPORT = root / "benchmarks/results/cpu-phone/report.json"
    gate.SIDE_RESULT_SPECS = {
        "spec_cpu2017": root / "benchmarks/results/cpu/spec/result.json",
        "coremark": root / "benchmarks/results/cpu/coremark/l5_l6_result.json",
        "dhrystone": root / "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
        "jetstream2": root / "benchmarks/results/cpu/jetstream/result.json",
    }
    gate.SIDE_RESULT_MANIFESTS = {
        "spec_cpu2017": root / "benchmarks/cpu/spec/manifest.json",
        "coremark": root / "benchmarks/cpu/coremark/manifest.json",
        "dhrystone": root / "benchmarks/cpu/dhrystone/manifest.json",
        "jetstream2": root / "benchmarks/cpu/jetstream/manifest.json",
    }


def populate_valid_root(root: Path) -> Path:
    configure_root(root)
    write_calibration_evidence(root)
    for name, path in gate.SIDE_RESULT_SPECS.items():
        write_json(path, side_result(name))
        raw_path = root / f"{name}.log"
        raw_path.write_text(raw_output_text(name), encoding="utf-8")
        metadata_path = root / f"benchmarks/metadata/{name}-target.json"
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(target_metadata_text(), encoding="utf-8")
        if name == "spec_cpu2017":
            manifest_path = root / "benchmarks/results/cpu/spec/run-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            (manifest_path.parent / "e1.cfg").write_text(SPEC_CONFIG_TEXT, encoding="utf-8")
            manifest_path.write_text(spec_run_manifest_text(), encoding="utf-8")
        write_json(
            gate.SIDE_RESULT_MANIFESTS[name],
            {
                "schema": "eliza.cpu_benchmark_manifest.v1",
                "benchmark": name,
                "status": "test",
                "claim_boundary": "test L5/L6 boundary",
                "run_command": f"scripts/run_{name}.sh",
                "fail_closed_until": ["real target evidence"],
            },
        )
    report_path = root / "benchmarks/results/cpu-phone/report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    (report_path.parent / "target-session.log").write_text(REPORT_TRANSCRIPT_TEXT, encoding="utf-8")
    (root / "bw.log").write_text(lmbench_raw_output_text("lmbench_bw_mem"), encoding="utf-8")
    (root / "lat.log").write_text(lmbench_raw_output_text("lmbench_lat_mem_rd"), encoding="utf-8")
    lmbench_metadata_path = root / "benchmarks/metadata/lmbench-target.json"
    lmbench_metadata_path.parent.mkdir(parents=True, exist_ok=True)
    lmbench_metadata_path.write_text(target_metadata_text(), encoding="utf-8")
    write_json(report_path, valid_benchmark_report())
    return report_path


def expect_status(report: dict[str, Any], status: str) -> None:
    if report["status"] != status:
        raise AssertionError(f"expected {status}, got {report}")


def test_valid_claim_passes() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        report = gate.build_report(report_path)
        expect_status(report, "pass")
        for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
            if report.get(claim_field) is not True:
                raise AssertionError(report)
        l5_l6_report = gate.build_l5_l6_report(report_path, report)
        expect_status(l5_l6_report, "pass")
        for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
            if l5_l6_report.get(claim_field) is not True:
                raise AssertionError(l5_l6_report)
        names = {item["name"] for item in l5_l6_report["entries"]}
        expected = set(gate.SIDE_RESULT_SPECS) | gate.REQUIRED_REPORT_BENCHES
        if names != expected:
            raise AssertionError(l5_l6_report)
        for entry in l5_l6_report["entries"]:
            if not entry.get("unblock", {}).get("next_command"):
                raise AssertionError(entry)
            if entry.get("claim_satisfied"):
                if not gate.has_sha256(entry.get("target_metadata_sha256")):
                    raise AssertionError(entry)
                if entry.get("target_runner") != "prototype":
                    raise AssertionError(entry)
                if entry["name"] == "spec_cpu2017":
                    if not gate.has_sha256(entry.get("spec_license_sha256")):
                        raise AssertionError(entry)
                    if not gate.has_sha256(entry.get("spec_run_manifest_sha256")):
                        raise AssertionError(entry)
    print("PASS valid phone CPU claim evidence accepted")


def test_blocked_side_result_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        write_json(gate.SIDE_RESULT_SPECS["coremark"], side_result("coremark", "blocked"))
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
            if report.get(claim_field) is not False:
                raise AssertionError(report)
        if not any(item["name"] == "coremark" for item in report["findings"]):
            raise AssertionError(report["findings"])
    print("PASS blocked side-result blocks phone CPU claim")


def test_blocked_side_result_requires_blocked_missing_target_evidence_provenance() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark", "blocked")
        payload["provenance"] = "measured"
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "blocked side result provenance" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS blocked side-result rejects measured provenance")


def test_blocked_side_result_requires_explicit_false_claim_flags() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark", "blocked")
        payload.pop("claim_allowed")
        payload["phone_claim_allowed"] = True
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        reason = finding.get("reason", "")
        if "claim_allowed" not in reason or "phone_claim_allowed" not in reason:
            raise AssertionError(finding)
    print("PASS blocked side-result requires explicit false claim flags")


def test_blocked_side_result_requires_specific_blockers() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("jetstream2", "blocked")
        payload["blocked_requirements"] = [
            {
                "name": "target.metadata",
                "reason": "missing metadata",
                "resolution": "Provide target metadata and rerun the harness.",
            }
        ]
        write_json(gate.SIDE_RESULT_SPECS["jetstream2"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "jetstream2")
        reason = finding.get("reason", "")
        if "blocked_requirements" not in reason or "riscv64_js_engine" not in reason:
            raise AssertionError(finding)
    print("PASS blocked side-result requires benchmark-specific blockers")


def test_blocked_side_result_requires_reason_and_requirement_shape() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("spec_cpu2017", "blocked")
        payload["reason"] = ""
        payload["blocked_requirements"] = [{"name": "licensed_spec_cpu2017_install"}]
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        reason = finding.get("reason", "")
        if (
            "non-empty reason" not in reason
            or "blocked_requirements[0].reason" not in reason
            or "blocked_requirements[0].resolution" not in reason
        ):
            raise AssertionError(finding)
    print("PASS blocked side-result requires reason and blocker shape")


def test_l1_side_result_blocks_phone_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        payload["claim_level"] = "L1_RTL_FULL_SOC"
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        l5_l6_report = gate.build_l5_l6_report(report_path, report)
        expect_status(l5_l6_report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "claim_level" not in finding.get("reason", ""):
            raise AssertionError(finding)
        entry = next(item for item in l5_l6_report["entries"] if item["name"] == "coremark")
        if entry["claim_satisfied"] or entry["claim_level"] != "L1_RTL_FULL_SOC":
            raise AssertionError(entry)
        if "real target evidence" not in entry.get("unblock", {}).get("required_evidence", []):
            raise AssertionError(entry)
    print("PASS L1 side-result cannot back phone CPU claim")


def test_side_result_missing_raw_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("dhrystone")
        del payload["artifacts"]["raw_output_sha256"]
        write_json(gate.SIDE_RESULT_SPECS["dhrystone"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "dhrystone")
        if "raw_output_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result missing raw-output hash blocks phone CPU claim")


def test_side_result_raw_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        payload["artifacts"]["raw_output_sha256"] = "9" * 64
        payload["target_execution"]["transcript_sha256"] = "9" * 64
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "does not match raw_output" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result raw-output hash mismatch blocks phone CPU claim")


def test_side_result_uppercase_raw_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        upper = payload["artifacts"]["raw_output_sha256"].upper()
        payload["artifacts"]["raw_output_sha256"] = upper
        payload["target_execution"]["transcript_sha256"] = upper
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "raw_output_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result uppercase raw-output hash blocks phone CPU claim")


def test_side_result_transcript_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        payload["target_execution"]["transcript_sha256"] = "9" * 64
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "transcript_sha256 does not match raw_output" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result transcript hash mismatch blocks phone CPU claim")


def test_side_result_top_level_raw_hash_does_not_satisfy_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("dhrystone")
        payload["raw_output_sha256"] = payload["artifacts"].pop("raw_output_sha256")
        write_json(gate.SIDE_RESULT_SPECS["dhrystone"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "dhrystone")
        if "artifacts.raw_output_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS top-level side-result raw hash cannot back phone CPU claim")


def test_side_result_requires_benchmark_specific_metrics() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("jetstream2")
        payload["metrics"] = {"score": 1.0}
        write_json(gate.SIDE_RESULT_SPECS["jetstream2"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "jetstream2")
        if "jetstream2_score" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result requires benchmark-specific metrics")


def test_side_result_rejects_nonpositive_or_nonnumeric_metrics() -> None:
    cases: list[tuple[str, Any]] = [
        ("jetstream2", "271.5"),
        ("jetstream2", 0),
        ("jetstream2", -1),
        ("coremark", True),
    ]
    for name, bad_value in cases:
        tmp, root = with_temp_root()
        with tmp:
            report_path = populate_valid_root(root)
            payload = side_result(name)
            first_metric = next(iter(gate.REQUIRED_SIDE_METRICS[name]))
            payload["metrics"][first_metric] = bad_value
            write_json(gate.SIDE_RESULT_SPECS[name], payload)
            report = gate.build_report(report_path)
            expect_status(report, "blocked")
            finding = next(item for item in report["findings"] if item["name"] == name)
            if "positive number" not in finding.get("reason", ""):
                raise AssertionError(finding)
    print("PASS side-result rejects nonpositive or nonnumeric metrics")


def test_side_result_requires_target_execution_runner() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        payload["target_execution"]["dut"] = payload["target_execution"].pop("runner")
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "target_execution.runner" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result requires target_execution.runner")


def test_side_result_missing_target_metadata_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark")
        del payload["artifacts"]["target_metadata_sha256"]
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "target_metadata_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result missing target metadata hash blocks phone CPU claim")


def test_side_result_placeholder_target_metadata_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        metadata_path = root / "benchmarks/metadata/jetstream2-target.json"
        bad = target_metadata_payload()
        bad["calibration"]["status"] = "blocked"
        bad_text = json.dumps(bad, indent=2) + "\n"
        metadata_path.write_text(bad_text, encoding="utf-8")
        payload = side_result("jetstream2")
        payload["artifacts"]["target_metadata_sha256"] = hashlib.sha256(
            bad_text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["jetstream2"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "jetstream2")
        if "metadata contract" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result placeholder target metadata blocks phone CPU claim")


def test_side_result_embedded_placeholder_metadata_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        metadata_path = root / "benchmarks/metadata/coremark-target.json"
        bad = target_metadata_payload()
        bad["clocks"]["source"] = "placeholder clock transcript"
        bad_text = json.dumps(bad, indent=2) + "\n"
        metadata_path.write_text(bad_text, encoding="utf-8")
        payload = side_result("coremark")
        payload["artifacts"]["target_metadata_sha256"] = hashlib.sha256(
            bad_text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "clocks.source" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result embedded placeholder metadata blocks phone CPU claim")


def test_side_result_missing_calibration_evidence_artifact_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        (root / "docs/evidence/calibration/clock-source.txt").unlink()
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "clock_source" not in finding.get(
            "reason", ""
        ) or "artifact is missing" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS missing calibration evidence artifact blocks phone CPU claim")


def test_side_result_calibration_evidence_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        (root / "docs/evidence/calibration/power-meter.txt").write_text(
            "tampered calibration transcript\n", encoding="utf-8"
        )
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "power_meter" not in finding.get("reason", "") or "does not match" not in finding.get(
            "reason", ""
        ):
            raise AssertionError(finding)
    print("PASS calibration evidence hash mismatch blocks phone CPU claim")


def test_side_result_missing_memory_metadata_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        metadata_path = root / "benchmarks/metadata/dhrystone-target.json"
        bad = target_metadata_payload()
        del bad["memory"]
        bad_text = json.dumps(bad, indent=2) + "\n"
        metadata_path.write_text(bad_text, encoding="utf-8")
        payload = side_result("dhrystone")
        payload["artifacts"]["target_metadata_sha256"] = hashlib.sha256(
            bad_text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["dhrystone"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "dhrystone")
        if "memory section" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result missing memory metadata blocks phone CPU claim")


def test_spec_side_result_missing_license_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("spec_cpu2017")
        del payload["artifacts"]["spec_license_sha256"]
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "spec_license_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result missing license hash blocks phone CPU claim")


def test_spec_side_result_placeholder_license_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("spec_cpu2017")
        payload["artifacts"]["spec_license_sha256"] = "0" * 64
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "non-placeholder" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result placeholder license hash blocks phone CPU claim")


def test_spec_side_result_requires_run_manifest() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("spec_cpu2017")
        del payload["artifacts"]["spec_run_manifest"]
        del payload["artifacts"]["spec_run_manifest_sha256"]
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "spec_run_manifest" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result requires run manifest")


def test_spec_side_result_rejects_nonreportable_manifest() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        manifest_path = root / "benchmarks/results/cpu/spec/run-manifest.json"
        manifest = json.loads(spec_run_manifest_text())
        manifest["reportable"] = False
        text = json.dumps(manifest, indent=2) + "\n"
        manifest_path.write_text(text, encoding="utf-8")
        payload = side_result("spec_cpu2017")
        payload["artifacts"]["spec_run_manifest_sha256"] = hashlib.sha256(
            text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "reportable=true" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result rejects nonreportable manifest")


def test_spec_side_result_rejects_mismatched_manifest_bundle_hash() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        manifest_path = root / "benchmarks/results/cpu/spec/run-manifest.json"
        manifest = json.loads(spec_run_manifest_text())
        manifest["result_bundle_sha256"] = "1" * 64
        text = json.dumps(manifest, indent=2) + "\n"
        manifest_path.write_text(text, encoding="utf-8")
        payload = side_result("spec_cpu2017")
        payload["artifacts"]["spec_run_manifest_sha256"] = hashlib.sha256(
            text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "result_bundle_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result rejects mismatched manifest bundle hash")


def test_spec_side_result_rejects_missing_config_hash() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        manifest_path = root / "benchmarks/results/cpu/spec/run-manifest.json"
        manifest = json.loads(spec_run_manifest_text())
        del manifest["config_sha256"]
        text = json.dumps(manifest, indent=2) + "\n"
        manifest_path.write_text(text, encoding="utf-8")
        payload = side_result("spec_cpu2017")
        payload["artifacts"]["spec_run_manifest_sha256"] = hashlib.sha256(
            text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "config_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result requires config hash")


def test_spec_side_result_rejects_mismatched_config_hash() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        manifest_path = root / "benchmarks/results/cpu/spec/run-manifest.json"
        manifest = json.loads(spec_run_manifest_text())
        manifest["config_sha256"] = "1" * 64
        text = json.dumps(manifest, indent=2) + "\n"
        manifest_path.write_text(text, encoding="utf-8")
        payload = side_result("spec_cpu2017")
        payload["artifacts"]["spec_run_manifest_sha256"] = hashlib.sha256(
            text.encode("utf-8")
        ).hexdigest()
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "config file does not match config_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS SPEC side-result rejects mismatched config hash")


def test_side_result_score_only_transcript_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        raw_path = root / "coremark.log"
        raw_path.write_text("Iterations/Sec: 12345.67\nCoreMark/MHz: 8.9\n", encoding="utf-8")
        payload = side_result("coremark")
        digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
        payload["artifacts"]["raw_output_sha256"] = digest
        payload["target_execution"]["transcript_sha256"] = digest
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "raw transcript missing required markers" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS score-only side-result transcript blocks phone CPU claim")


def test_dhrystone_unblock_names_l5_l6_target() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("dhrystone", "blocked")
        payload["reason"] = "phone/prototype target transcript missing"
        write_json(gate.SIDE_RESULT_SPECS["dhrystone"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        l5_l6_report = gate.build_l5_l6_report(report_path, report)
        entry = next(item for item in l5_l6_report["entries"] if item["name"] == "dhrystone")
        next_command = entry.get("unblock", {}).get("next_command", "")
        if "make dhrystone-l5-l6" not in next_command:
            raise AssertionError(entry)
        if "E1_DHRYSTONE_RAW_OUTPUT" not in next_command:
            raise AssertionError(entry)
    print("PASS Dhrystone L5/L6 report names concrete target command")


def test_coremark_unblock_names_l5_l6_target() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("coremark", "blocked")
        payload["reason"] = "phone/prototype target transcript missing"
        write_json(gate.SIDE_RESULT_SPECS["coremark"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        l5_l6_report = gate.build_l5_l6_report(report_path, report)
        entry = next(item for item in l5_l6_report["entries"] if item["name"] == "coremark")
        next_command = entry.get("unblock", {}).get("next_command", "")
        if "make coremark-l5-l6" not in next_command:
            raise AssertionError(entry)
        if "E1_COREMARK_RAW_OUTPUT" not in next_command:
            raise AssertionError(entry)
    print("PASS CoreMark L5/L6 report names concrete target command")


def test_side_result_missing_metrics_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = side_result("spec_cpu2017")
        del payload["metrics"]
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "spec_cpu2017")
        if "metrics" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS side-result missing metrics blocks phone CPU claim")


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


def test_invalid_lmbench_hash_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["results"][0]["artifacts"]["raw_output_sha256"] = "not-a-sha"
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "raw_output_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS invalid lmbench raw-output hash blocks phone CPU claim")


def test_lmbench_transcript_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["results"][0]["target_execution"]["transcript_sha256"] = "9" * 64
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "transcript_sha256 does not match raw_output" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS lmbench transcript hash mismatch blocks phone CPU claim")


def test_lmbench_missing_target_metadata_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        del payload["results"][0]["artifacts"]["target_metadata_sha256"]
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "target_metadata_sha256" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS lmbench missing target metadata hash blocks phone CPU claim")


def test_missing_lmbench_metrics_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        del payload["results"][1]["metrics"]
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_lat_mem_rd")
        if "metrics" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS missing lmbench metrics blocks phone CPU claim")


def test_lmbench_wrong_metric_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["results"][0]["metrics"] = {"mb_per_s": 1.0}
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "bandwidth_mb_per_s" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS lmbench benchmark-specific metric required")


def test_lmbench_missing_required_calibration_asset_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        payload["results"][0]["run_metadata"]["required_calibration_assets"].remove("memory_model")
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "memory_model" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS lmbench required calibration assets are fixed by gate")


def test_lmbench_missing_required_calibration_asset_evidence_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        (root / "docs/evidence/calibration/lmbench-binary.txt").unlink()
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        if "lmbench_binary" not in finding.get(
            "reason", ""
        ) or "artifact is missing" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS lmbench required calibration asset evidence is checked")


def test_lmbench_required_calibration_asset_sha_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        payload = copy.deepcopy(valid_benchmark_report())
        del payload["calibration"]["assets"]["lmbench_binary"]["sha256"]
        payload["calibration"]["assets"]["memory_model"]["sha256"] = "not-a-sha"
        write_json(report_path, payload)
        report = gate.build_report(report_path)
        expect_status(report, "blocked")
        finding = next(item for item in report["findings"] if item["name"] == "lmbench_bw_mem")
        reason = finding.get("reason", "")
        if "lmbench_binary.sha256" not in reason or "memory_model.sha256" not in reason:
            raise AssertionError(finding)
    print("PASS lmbench calibration asset sha256 is mandatory")


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


def test_no_write_mode_skips_report_artifacts() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        old_argv = sys.argv[:]
        try:
            sys.argv = [
                "check_cpu_phone_benchmark_claim_gate.py",
                "--report",
                str(report_path),
                "--no-write",
            ]
            exit_code = gate.main()
        finally:
            sys.argv = old_argv
        if exit_code != 0:
            raise AssertionError(exit_code)
        if gate.OUT.exists() or gate.L5_L6_OUT.exists():
            raise AssertionError("no-write mode created gate report artifacts")
    print("PASS no-write mode skips phone gate report artifacts")


def test_strict_mode_blocks_without_report_artifacts() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], side_result("spec_cpu2017", "blocked"))
        old_argv = sys.argv[:]
        try:
            sys.argv = [
                "check_cpu_phone_benchmark_claim_gate.py",
                "--report",
                str(report_path),
                "--strict",
                "--no-write",
            ]
            exit_code = gate.main()
        finally:
            sys.argv = old_argv
        if exit_code != 2:
            raise AssertionError(exit_code)
        if gate.OUT.exists() or gate.L5_L6_OUT.exists():
            raise AssertionError("strict no-write mode created gate report artifacts")
    print("PASS strict no-write mode blocks without report artifacts")


def test_non_strict_mode_writes_blocked_l5_l6_report() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], side_result("spec_cpu2017", "blocked"))
        old_argv = sys.argv[:]
        try:
            sys.argv = [
                "check_cpu_phone_benchmark_claim_gate.py",
                "--report",
                str(report_path),
            ]
            exit_code = gate.main()
        finally:
            sys.argv = old_argv
        if exit_code != 0:
            raise AssertionError(exit_code)
        if not gate.OUT.is_file() or not gate.L5_L6_OUT.is_file():
            raise AssertionError("non-strict mode did not write blocked report artifacts")
        gate_report = json.loads(gate.OUT.read_text(encoding="utf-8"))
        l5_l6_report = json.loads(gate.L5_L6_OUT.read_text(encoding="utf-8"))
        if (
            gate_report.get("status") != "blocked"
            or gate_report.get("claim_allowed") is not False
            or gate_report.get("phone_claim_allowed") is not False
            or gate_report.get("release_claim_allowed") is not False
        ):
            raise AssertionError(gate_report)
        if (
            l5_l6_report.get("status") != "blocked"
            or l5_l6_report.get("claim_allowed") is not False
            or l5_l6_report.get("phone_claim_allowed") is not False
            or l5_l6_report.get("release_claim_allowed") is not False
        ):
            raise AssertionError(l5_l6_report)
        spec_entry = next(
            item for item in l5_l6_report["entries"] if item["name"] == "spec_cpu2017"
        )
        if spec_entry.get("claim_satisfied") is not False or not spec_entry.get("reason"):
            raise AssertionError(spec_entry)
    print("PASS non-strict mode writes blocked L5/L6 report")


def test_l5_l6_rollup_schema_validator_rejects_drift() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        report = gate.build_report(report_path)
        l5_l6_report = gate.build_l5_l6_report(report_path, report)
        errors = gate.validate_l5_l6_report(l5_l6_report)
        if errors:
            raise AssertionError(errors)
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], side_result("spec_cpu2017", "blocked"))
        blocked_report = gate.build_report(report_path)
        l5_l6_report = gate.build_l5_l6_report(report_path, blocked_report)
        errors = gate.validate_l5_l6_report(l5_l6_report)
        if errors:
            raise AssertionError(errors)
        if (
            l5_l6_report.get("claim_allowed") is not False
            or l5_l6_report.get("phone_claim_allowed") is not False
            or l5_l6_report.get("release_claim_allowed") is not False
        ):
            raise AssertionError(l5_l6_report)
        drifted = copy.deepcopy(l5_l6_report)
        drifted.pop("phone_claim_allowed", None)
        errors = gate.validate_l5_l6_report(drifted)
        if not any("phone_claim_allowed" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["release_claim_allowed"] = True
        errors = gate.validate_l5_l6_report(drifted)
        if not any("release_claim_allowed" in error for error in errors):
            raise AssertionError(errors)
        blocked_spec = l5_l6_report["entries"][0]
        if (
            blocked_spec.get("blocked_requirements_count")
            != len(gate.REQUIRED_BLOCKED_SIDE_REQUIREMENTS["spec_cpu2017"])
            or set(blocked_spec.get("blocked_requirement_names") or [])
            != gate.REQUIRED_BLOCKED_SIDE_REQUIREMENTS["spec_cpu2017"]
            or "licensed_spec_cpu2017_install"
            not in blocked_spec.get("blocked_requirements_summary", "")
            or blocked_spec.get("claim_allowed") is not False
            or blocked_spec.get("phone_claim_allowed") is not False
            or blocked_spec.get("release_claim_allowed") is not False
        ):
            raise AssertionError(blocked_spec)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0].pop("blocked_requirement_names", None)
        errors = gate.validate_l5_l6_report(drifted)
        if not any("missing blocker IDs" in error for error in errors):
            raise AssertionError(errors)
        if not any("blocked_requirement_names" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0]["blocked_requirement_names"] = []
        errors = gate.validate_l5_l6_report(drifted)
        if not any("no blocked_requirement_names" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0]["blocked_requirement_names"] = ["licensed_spec_cpu2017_install", ""]
        errors = gate.validate_l5_l6_report(drifted)
        if not any("blocked_requirement_names[1]" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0].pop("blocked_requirements_summary", None)
        errors = gate.validate_l5_l6_report(drifted)
        if not any("blocked_requirements_summary" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0]["blocked_requirements_count"] = 1
        errors = gate.validate_l5_l6_report(drifted)
        if not any("blocked side-result entry" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0]["claim_satisfied"] = True
        drifted["entries"][0]["record_status"] = "blocked"
        drifted["blocked_count"] = 0
        errors = gate.validate_l5_l6_report(drifted)
        if not any("record_status passed" in error for error in errors):
            raise AssertionError(errors)
        if not any("gate_status pass" in error for error in errors):
            raise AssertionError(errors)
        if not any("blocked_count" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(l5_l6_report)
        drifted["entries"][0]["gate_status"] = "pass"
        errors = gate.validate_l5_l6_report(drifted)
        if not any("pass gate_status entry must be claim_satisfied" in error for error in errors):
            raise AssertionError(errors)
        write_json(gate.SIDE_RESULT_SPECS["spec_cpu2017"], side_result("spec_cpu2017"))
        report = gate.build_report(report_path)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        drifted["entries"][0].pop("target_metadata_sha256", None)
        errors = gate.validate_l5_l6_report(drifted)
        if not any("target_metadata_sha256" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        drifted["entries"][0]["raw_output_sha256"] = "0" * 64
        drifted["entries"][0]["target_metadata_sha256"] = drifted["entries"][0][
            "target_metadata_sha256"
        ].upper()
        errors = gate.validate_l5_l6_report(drifted)
        if not any("non-placeholder raw_output_sha256" in error for error in errors):
            raise AssertionError(errors)
        if not any("non-placeholder target_metadata_sha256" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        drifted["entries"][0]["target_runner"] = "host"
        errors = gate.validate_l5_l6_report(drifted)
        if not any("target_runner" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        drifted["entries"][0].pop("spec_run_manifest_sha256", None)
        errors = gate.validate_l5_l6_report(drifted)
        if not any("spec_run_manifest_sha256" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        drifted["required_benchmarks"] = ["coremark"]
        errors = gate.validate_l5_l6_report(drifted)
        if not any("required_benchmarks" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        for entry in drifted["entries"]:
            if entry["name"] == "jetstream2":
                entry["metrics"] = {"score": 271.5}
                break
        errors = gate.validate_l5_l6_report(drifted)
        if not any("jetstream2_score" in error for error in errors):
            raise AssertionError(errors)
        drifted = copy.deepcopy(gate.build_l5_l6_report(report_path, report))
        for entry in drifted["entries"]:
            if entry["name"] == "lmbench_lat_mem_rd":
                entry["metrics"] = {"points": [{"latency_ns": 98.5}]}
                break
        errors = gate.validate_l5_l6_report(drifted)
        if not any("max_latency_ns" in error for error in errors):
            raise AssertionError(errors)
    print("PASS L5/L6 rollup schema validator rejects drift")


def test_report_process_contract_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        data = json.loads(report_path.read_text(encoding="utf-8"))
        data["process"]["process_effects_contract"]["sha256"] = "a" * 64
        write_json(report_path, data)
        report = gate.build_report(report_path)
        finding = next(
            item for item in report["findings"] if item["name"] == "benchmark_report_schema"
        )
        if "process_effects_contract.sha256" not in finding["reason"]:
            raise AssertionError(finding)
    print("PASS report process contract hash mismatch blocks phone CPU claim")


def test_report_target_execution_transcript_hash_mismatch_blocks_claim() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        data = json.loads(report_path.read_text(encoding="utf-8"))
        data["target_execution"]["transcript_sha256"] = "a" * 64
        write_json(report_path, data)
        report = gate.build_report(report_path)
        finding = next(
            item for item in report["findings"] if item["name"] == "benchmark_report_schema"
        )
        if "target_execution.transcript_sha256" not in finding["reason"]:
            raise AssertionError(finding)
        if not any(
            item["name"] == "benchmark_report_target_execution"
            and "transcript_sha256 does not match transcript_path" in item["reason"]
            for item in report["findings"]
        ):
            raise AssertionError(report["findings"])
    print("PASS report target transcript hash mismatch blocks phone CPU claim")


def test_coremark_side_result_requires_binary_calibration_asset() -> None:
    tmp, root = with_temp_root()
    with tmp:
        report_path = populate_valid_root(root)
        metadata_path = root / "benchmarks/metadata/coremark-target.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        del metadata["calibration"]["assets"]["coremark_binary"]
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        report = gate.build_report(report_path)
        finding = next(item for item in report["findings"] if item["name"] == "coremark")
        if "coremark_binary" not in finding.get("reason", ""):
            raise AssertionError(finding)
    print("PASS CoreMark side result requires binary calibration asset")


def test_dhrystone_and_jetstream_side_results_require_binary_assets() -> None:
    cases = {
        "dhrystone": "dhrystone_binary",
        "jetstream2": "jetstream_engine",
    }
    for bench_name, asset_name in cases.items():
        tmp, root = with_temp_root()
        with tmp:
            report_path = populate_valid_root(root)
            metadata_path = root / f"benchmarks/metadata/{bench_name}-target.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            del metadata["calibration"]["assets"][asset_name]
            metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            report = gate.build_report(report_path)
            finding = next(item for item in report["findings"] if item["name"] == bench_name)
            if asset_name not in finding.get("reason", ""):
                raise AssertionError(finding)
    print("PASS Dhrystone and JetStream side results require binary calibration assets")


def main() -> None:
    test_valid_claim_passes()
    test_blocked_side_result_blocks_claim()
    test_blocked_side_result_requires_blocked_missing_target_evidence_provenance()
    test_blocked_side_result_requires_explicit_false_claim_flags()
    test_blocked_side_result_requires_specific_blockers()
    test_blocked_side_result_requires_reason_and_requirement_shape()
    test_l1_side_result_blocks_phone_claim()
    test_side_result_missing_raw_hash_blocks_claim()
    test_side_result_raw_hash_mismatch_blocks_claim()
    test_side_result_uppercase_raw_hash_blocks_claim()
    test_side_result_transcript_hash_mismatch_blocks_claim()
    test_side_result_top_level_raw_hash_does_not_satisfy_claim()
    test_side_result_requires_benchmark_specific_metrics()
    test_side_result_rejects_nonpositive_or_nonnumeric_metrics()
    test_side_result_requires_target_execution_runner()
    test_side_result_missing_target_metadata_hash_blocks_claim()
    test_side_result_placeholder_target_metadata_blocks_claim()
    test_side_result_embedded_placeholder_metadata_blocks_claim()
    test_side_result_missing_calibration_evidence_artifact_blocks_claim()
    test_side_result_calibration_evidence_hash_mismatch_blocks_claim()
    test_side_result_missing_memory_metadata_blocks_claim()
    test_spec_side_result_missing_license_hash_blocks_claim()
    test_spec_side_result_placeholder_license_hash_blocks_claim()
    test_spec_side_result_requires_run_manifest()
    test_spec_side_result_rejects_nonreportable_manifest()
    test_spec_side_result_rejects_mismatched_manifest_bundle_hash()
    test_spec_side_result_rejects_missing_config_hash()
    test_spec_side_result_rejects_mismatched_config_hash()
    test_side_result_score_only_transcript_blocks_claim()
    test_dhrystone_unblock_names_l5_l6_target()
    test_coremark_unblock_names_l5_l6_target()
    test_side_result_missing_metrics_blocks_claim()
    test_missing_lmbench_result_blocks_claim()
    test_l2_report_blocks_claim()
    test_missing_raw_hash_blocks_claim()
    test_invalid_lmbench_hash_blocks_claim()
    test_lmbench_transcript_hash_mismatch_blocks_claim()
    test_lmbench_missing_target_metadata_blocks_claim()
    test_missing_lmbench_metrics_blocks_claim()
    test_lmbench_wrong_metric_blocks_claim()
    test_lmbench_missing_required_calibration_asset_blocks_claim()
    test_lmbench_missing_required_calibration_asset_evidence_blocks_claim()
    test_lmbench_required_calibration_asset_sha_blocks_claim()
    test_missing_report_includes_real_run_command()
    test_blocked_lmbench_result_summarizes_requirements()
    test_no_write_mode_skips_report_artifacts()
    test_strict_mode_blocks_without_report_artifacts()
    test_non_strict_mode_writes_blocked_l5_l6_report()
    test_l5_l6_rollup_schema_validator_rejects_drift()
    test_report_process_contract_hash_mismatch_blocks_claim()
    test_report_target_execution_transcript_hash_mismatch_blocks_claim()
    test_coremark_side_result_requires_binary_calibration_asset()
    test_dhrystone_and_jetstream_side_results_require_binary_assets()


if __name__ == "__main__":
    main()
