#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_cpu_npu_2028_readiness_scorecard.py"
SCORECARD = ROOT / "docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml"
PHONE_CPU_GATE = ROOT / "build/reports/cpu_phone_benchmark_claim_gate.json"
PHONE_CPU_L5_L6_REPORT = ROOT / "build/reports/cpu_phone_l5_l6_benchmark_report.json"


def run_check() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECK)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_scorecard_checker_passes() -> None:
    result = run_check()
    if result.returncode != 0:
        raise AssertionError(result.stdout)


def test_scorecard_rejects_modeled_point_drift() -> None:
    original = SCORECARD.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["modeled_operating_point"]["memory_sustained_gbps"] = 120.0
        SCORECARD.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "modeled_operating_point.memory_sustained_gbps drifted" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        SCORECARD.write_text(original, encoding="utf-8")


def test_scorecard_rejects_missing_nnapi_domain() -> None:
    original = SCORECARD.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["proof_domains"] = [
            item for item in data["proof_domains"] if item["id"] != "npu_nnapi"
        ]
        SCORECARD.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "proof_domains missing: npu_nnapi" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        SCORECARD.write_text(original, encoding="utf-8")


def test_scorecard_rejects_missing_branch_prediction_domain() -> None:
    original = SCORECARD.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["proof_domains"] = [
            item for item in data["proof_domains"] if item["id"] != "branch_prediction"
        ]
        SCORECARD.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "proof_domains missing: branch_prediction" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        SCORECARD.write_text(original, encoding="utf-8")


def test_scorecard_rejects_missing_phone_cpu_l5_l6_entry() -> None:
    original = SCORECARD.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["required_phone_cpu_l5_l6_entries"].remove("jetstream2")
        SCORECARD.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "required_phone_cpu_l5_l6_entries missing: jetstream2" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        SCORECARD.write_text(original, encoding="utf-8")


def test_scorecard_rejects_phone_cpu_claim_promotion() -> None:
    original_gate = PHONE_CPU_GATE.read_text(encoding="utf-8")
    original_l5_l6 = PHONE_CPU_L5_L6_REPORT.read_text(encoding="utf-8")
    try:
        gate = json.loads(original_gate)
        gate["claim_allowed"] = True
        PHONE_CPU_GATE.write_text(
            json.dumps(gate, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        l5_l6 = json.loads(original_l5_l6)
        l5_l6["claim_allowed"] = True
        l5_l6["entries"][0]["claim_satisfied"] = True
        PHONE_CPU_L5_L6_REPORT.write_text(
            json.dumps(l5_l6, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        expected = (
            "phone CPU benchmark gate claim_allowed must remain false",
            "phone CPU L5/L6 report claim_allowed must remain false",
            "phone CPU L5/L6 report unexpectedly satisfies entries: spec_cpu2017",
        )
        for text in expected:
            if text not in result.stdout:
                raise AssertionError(result.stdout)
    finally:
        PHONE_CPU_GATE.write_text(original_gate, encoding="utf-8")
        PHONE_CPU_L5_L6_REPORT.write_text(original_l5_l6, encoding="utf-8")


def test_scorecard_rejects_stale_phone_cpu_gate_artifact() -> None:
    original_gate = PHONE_CPU_GATE.read_text(encoding="utf-8")
    try:
        gate = json.loads(original_gate)
        gate["required_side_results"]["spec_cpu2017"] = "stale/spec.json"
        PHONE_CPU_GATE.write_text(
            json.dumps(gate, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "phone CPU benchmark gate report is stale" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        PHONE_CPU_GATE.write_text(original_gate, encoding="utf-8")


def test_scorecard_rejects_stale_phone_cpu_l5_l6_artifact() -> None:
    original_l5_l6 = PHONE_CPU_L5_L6_REPORT.read_text(encoding="utf-8")
    try:
        l5_l6 = json.loads(original_l5_l6)
        l5_l6["required_benchmarks"] = ["coremark"]
        for entry in l5_l6["entries"]:
            if entry.get("name") == "spec_cpu2017":
                entry.pop("blocked_requirements_count", None)
                break
        PHONE_CPU_L5_L6_REPORT.write_text(
            json.dumps(l5_l6, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        expected = (
            "phone CPU L5/L6 report is stale",
            "phone CPU L5/L6 report l5/l6 report required_benchmarks drifted",
        )
        for text in expected:
            if text not in result.stdout:
                raise AssertionError(result.stdout)
    finally:
        PHONE_CPU_L5_L6_REPORT.write_text(original_l5_l6, encoding="utf-8")


def test_scorecard_rejects_robustness_drift() -> None:
    original = SCORECARD.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["modeled_robustness"]["pass"] = False
        data["modeled_robustness"]["failing_cases"] = ["combined_guardband"]
        SCORECARD.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "modeled_robustness.pass must be true" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        SCORECARD.write_text(original, encoding="utf-8")


def main() -> int:
    for test in (
        test_scorecard_checker_passes,
        test_scorecard_rejects_modeled_point_drift,
        test_scorecard_rejects_missing_nnapi_domain,
        test_scorecard_rejects_missing_branch_prediction_domain,
        test_scorecard_rejects_missing_phone_cpu_l5_l6_entry,
        test_scorecard_rejects_phone_cpu_claim_promotion,
        test_scorecard_rejects_stale_phone_cpu_gate_artifact,
        test_scorecard_rejects_stale_phone_cpu_l5_l6_artifact,
        test_scorecard_rejects_robustness_drift,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
