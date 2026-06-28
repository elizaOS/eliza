#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "benchmarks/power/scripts/check_sustained_run_evidence.py"

spec = importlib.util.spec_from_file_location("check_sustained_run_evidence", CHECKER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {CHECKER}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def measured_manifest(base: Path) -> dict[str, object]:
    power = base / "power.csv"
    thermal = base / "thermal.csv"
    frequency = base / "frequency.csv"
    transcript = base / "workload.log"
    calibration = base / "calibration.json"
    write_text(power, "timestamp_s,watts\n0,4.0\n900,4.2\n1800,4.4\n")
    write_text(thermal, "timestamp_s,die_c\n0,42.0\n900,57.2\n1800,61.5\n")
    write_text(
        frequency, "timestamp_s,frequency_hz\n0,1000000000\n900,1000000000\n1800,1000000000\n"
    )
    write_text(
        transcript,
        "\n".join(
            [
                "eliza-evidence: status=PASS",
                "NNAPI_ACCELERATOR=e1-npu",
                "CPU_FALLBACK_PERCENT=0",
                "UNSUPPORTED_OP_COUNT=0",
                "",
            ]
        ),
    )
    write_text(
        calibration,
        json.dumps(
            {
                "schema": "eliza.power_thermal_calibration.v1",
                "status": "complete",
                "power": [{"instrument": "lab-supply", "calibrated_utc": "2026-05-19T00:00:00Z"}],
                "thermal": [
                    {"instrument": "thermal-sensor", "calibrated_utc": "2026-05-19T00:00:00Z"}
                ],
                "frequency": [{"instrument": "counter", "calibrated_utc": "2026-05-19T00:00:00Z"}],
            },
            indent=2,
        )
        + "\n",
    )

    artifacts = {
        "power_trace": power,
        "thermal_trace": thermal,
        "frequency_trace": frequency,
        "workload_transcript": transcript,
        "calibration_record": calibration,
    }
    return {
        "schema": "eliza.sustained_power_thermal_evidence.v1",
        "status": "complete_measured_evidence",
        "claim_boundary": "measured prototype silicon sustained run only",
        "target": {
            "name": "eliza-e1-npu",
            "substrate": "prototype_silicon",
            "board_serial": "unit-test-board",
            "soc_revision": "unit-test-rev",
        },
        "workload": {
            "plan_id": "e1-npu-sustained-int8-v1",
            "duration_seconds": 1800,
            "warmup_seconds": 120,
            "commands": [["adb", "shell", "benchmark_model", "--use_nnapi=true"]],
        },
        "measurement_environment": {
            "ambient_c": 25,
            "cooling": "passive-phone-fixture",
            "enclosure": "complete-phone",
            "operator": "unit-test",
        },
        "instrumentation": {
            "capture_statuses": {
                "power_meter_calibrated": "complete",
                "thermal_sensor_calibrated": "complete",
                "frequency_source_recorded": "complete",
                "workload_transcript_recorded": "complete",
                "throttle_state_recorded": "complete",
                "same_window_alignment_checked": "complete",
            },
            "power": [{"rail": "VDDCORE", "instrument": "lab-supply"}],
            "thermal": [{"sensor": "die", "instrument": "thermal-sensor"}],
            "frequency": [{"domain": "e1-npu", "source": "counter"}],
        },
        "artifacts": {
            name: {"path": rel(path), "sha256": sha256_file(path), "sample_count": 3}
            for name, path in artifacts.items()
        },
        "computed_metrics": {
            "average_watts": 4.2,
            "max_die_c": 61.5,
            "sustained_int8_tops": 42.0,
            "sustained_tops_per_w": 10.0,
            "throttle_state": "none",
        },
        "release_blockers": [],
    }


def run_checker(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), str(path)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_complete_measured_manifest_checks_trace_contents() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        manifest = measured_manifest(Path(td))
        path = Path(td) / "manifest.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        result = run_checker(path)
    if result.returncode != 0:
        raise AssertionError(result.stdout)


def test_complete_measured_manifest_rejects_metric_drift() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        manifest = measured_manifest(Path(td))
        drifted = copy.deepcopy(manifest)
        assert isinstance(drifted, dict)
        metrics = drifted["computed_metrics"]
        assert isinstance(metrics, dict)
        metrics["sustained_tops_per_w"] = 999.0
        path = Path(td) / "manifest.json"
        path.write_text(json.dumps(drifted, indent=2) + "\n", encoding="utf-8")
        result = run_checker(path)
    if result.returncode != 1:
        raise AssertionError(result.stdout)
    if "sustained_tops_per_w must equal" not in result.stdout:
        raise AssertionError(result.stdout)


def test_complete_measured_manifest_reports_missing_trace_without_crashing() -> None:
    parent = ROOT / "benchmarks/results/test-temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as td:
        manifest = measured_manifest(Path(td))
        artifacts = manifest["artifacts"]
        assert isinstance(artifacts, dict)
        power_artifact = artifacts["power_trace"]
        assert isinstance(power_artifact, dict)
        missing_path = ROOT / str(power_artifact["path"])
        missing_path.unlink()
        path = Path(td) / "manifest.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        result = run_checker(path)
    if result.returncode != 1:
        raise AssertionError(result.stdout)
    if "referenced file is missing" not in result.stdout:
        raise AssertionError(result.stdout)


def test_blocked_template_is_valid_but_not_release_evidence() -> None:
    path = ROOT / "benchmarks/power/manifests/e1-npu-sustained-capture.template.json"
    result = run_checker(path)
    if result.returncode != 2:
        raise AssertionError(result.stdout)
    allowed = subprocess.run(
        [sys.executable, str(CHECKER), str(path), "--allow-blocked"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if allowed.returncode != 0:
        raise AssertionError(allowed.stdout)


def main() -> int:
    for test in (
        test_complete_measured_manifest_checks_trace_contents,
        test_complete_measured_manifest_rejects_metric_drift,
        test_complete_measured_manifest_reports_missing_trace_without_crashing,
        test_blocked_template_is_valid_but_not_release_evidence,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
