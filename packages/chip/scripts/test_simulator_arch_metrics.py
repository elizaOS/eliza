#!/usr/bin/env python3
"""Unit tests for QEMU-derived simulator metrics generation."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "benchmarks/generate_simulator_arch_metrics.py"
BANNER = "eliza e1 qemu"


def run_generator(qemu_log: Path, out: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    command = [
        "python3",
        str(GENERATOR),
        "--qemu-log",
        str(qemu_log),
        "--out",
        str(out),
        *extra_args,
    ]
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def test_missing_qemu_log_fails() -> None:
    with tempfile.TemporaryDirectory() as td:
        result = run_generator(Path(td) / "missing.log", Path(td) / "metrics.json")
    if result.returncode == 0:
        raise AssertionError("missing QEMU log unexpectedly passed")
    if "missing qemu smoke log" not in result.stdout:
        raise AssertionError(result.stdout)


def test_wrong_banner_fails() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        qemu_log = root / "qemu.log"
        out = root / "metrics.json"
        qemu_log.write_text("unrelated uart output\n", encoding="utf-8")
        result = run_generator(qemu_log, out)
    if result.returncode == 0:
        raise AssertionError("wrong QEMU banner unexpectedly passed")
    if "does not contain required banner" not in result.stdout:
        raise AssertionError(result.stdout)


def test_liveness_metrics_are_not_performance_evidence() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        qemu_log = root / "qemu.log"
        out = root / "metrics.json"
        qemu_log.write_text(BANNER + "\n", encoding="utf-8")
        result = run_generator(qemu_log, out)
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        data = json.loads(out.read_text(encoding="utf-8"))

    expected = {
        "schema": "eliza.simulator_arch_metrics.v1",
        "evidence_class": "qemu_virt_liveness_only",
        "claim_boundary": "not_performance_evidence",
        "calibration_status": "uncalibrated",
        "benchmark_success_allowed": False,
        "target_cycles": 0,
        "simulated_frequency_hz": 0,
        "ipc": 0,
    }
    for key, value in expected.items():
        if data.get(key) != value:
            raise AssertionError(f"{key} expected {value!r}, got {data.get(key)!r}")
    forbidden = {"wall_clock_score", "phone_score", "geekbench_score"}
    present = sorted(forbidden & set(data))
    if present:
        raise AssertionError("forbidden comparable score fields present: " + ", ".join(present))


def test_14a_cpu_ap_model_exports_process_power_thermal_metrics() -> None:
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "metrics.json"
        result = run_generator(
            Path(td) / "unused-qemu.log",
            out,
            "--mode",
            "model-14a-cpu-ap",
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        data = json.loads(out.read_text(encoding="utf-8"))

    expected = {
        "schema": "eliza.simulator_arch_metrics.v1",
        "evidence_class": "deterministic_14a_cpu_ap_arch_model",
        "benchmark_success_allowed": True,
        "process_corner_count": 4,
    }
    for key, value in expected.items():
        if data.get(key) != value:
            raise AssertionError(f"{key} expected {value!r}, got {data.get(key)!r}")
    if data.get("process_effects_contract", {}).get("path") != (
        "docs/spec-db/process-14a-effects.yaml"
    ):
        raise AssertionError("14A model must hash the process effects contract")
    for key in (
        "target_cycles",
        "simulated_frequency_hz",
        "ipc",
        "estimated_package_power_w",
        "estimated_die_temp_c",
        "instructions_per_joule",
        "worst_process_corner_ipc",
        "worst_process_corner_frequency_hz",
        "worst_process_corner_power_w",
        "worst_process_corner_die_temp_c",
    ):
        value = data.get(key)
        if not isinstance(value, int | float) or isinstance(value, bool) or value <= 0:
            raise AssertionError(f"{key} must be positive numeric, got {value!r}")
    forbidden = {"wall_clock_score", "phone_score", "geekbench_score"}
    present = sorted(forbidden & set(data))
    if present:
        raise AssertionError("forbidden comparable score fields present: " + ", ".join(present))
    corners = data.get("process_corners")
    if not isinstance(corners, list) or len(corners) != 4:
        raise AssertionError("14A model must include four process corners")
    if not all(
        corner.get("release_use") == "prohibited_until_pdk_extracted_timing_power_thermal_signoff"
        for corner in corners
        if isinstance(corner, dict)
    ):
        raise AssertionError("modeled process corners must remain prohibited for release use")


def test_14a_sota_cpu_ap_model_improves_modeled_ipc_without_release_claim() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        baseline = root / "baseline.json"
        sota = root / "sota.json"
        baseline_result = run_generator(
            root / "unused-qemu.log",
            baseline,
            "--mode",
            "model-14a-cpu-ap",
        )
        if baseline_result.returncode != 0:
            raise AssertionError(baseline_result.stdout)
        sota_result = run_generator(
            root / "unused-qemu.log",
            sota,
            "--mode",
            "model-14a-cpu-ap",
            "--profile",
            "sota_2core",
            "--base-frequency-hz",
            "3800000000",
            "--base-power-w",
            "3.1",
            "--ipc-scale",
            "1.35",
            "--mpki-scale",
            "0.62",
        )
        if sota_result.returncode != 0:
            raise AssertionError(sota_result.stdout)
        baseline_data = json.loads(baseline.read_text(encoding="utf-8"))
        sota_data = json.loads(sota.read_text(encoding="utf-8"))

    if sota_data.get("config", {}).get("profile") != "sota_2core":
        raise AssertionError("SOTA model must record its CPU profile")
    if float(sota_data.get("ipc", 0.0)) <= float(baseline_data.get("ipc", 0.0)):
        raise AssertionError("SOTA CPU model must improve modeled IPC")
    if int(sota_data.get("simulated_frequency_hz", 0)) <= int(
        baseline_data.get("simulated_frequency_hz", 0)
    ):
        raise AssertionError("SOTA CPU model must improve modeled frequency")
    if "not_pdk" not in json.dumps(sota_data.get("process_corners", [])):
        raise AssertionError("SOTA CPU process corners must keep PDK signoff blocked")
    if "phone_score" in sota_data:
        raise AssertionError("SOTA CPU model must not emit phone-comparable score fields")


def main() -> int:
    for test in (
        test_missing_qemu_log_fails,
        test_wrong_banner_fails,
        test_liveness_metrics_are_not_performance_evidence,
        test_14a_cpu_ap_model_exports_process_power_thermal_metrics,
        test_14a_sota_cpu_ap_model_improves_modeled_ipc_without_release_claim,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
