#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_cpu_npu_2028_readiness_scorecard.py"
SCORECARD = ROOT / "docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml"


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
        test_scorecard_rejects_robustness_drift,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
