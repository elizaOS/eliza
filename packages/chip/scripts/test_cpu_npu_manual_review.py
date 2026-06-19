#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_cpu_npu_manual_review.py"
REVIEW = ROOT / "docs/architecture-optimization/cpu-npu-2028-manual-review.yaml"


def run_check() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECK)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_manual_review_checker_passes() -> None:
    result = run_check()
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    data = yaml.safe_load(REVIEW.read_text(encoding="utf-8"))
    flags = {key: value for key, value in data.items() if key.endswith("_claim_allowed")}
    if not flags or any(value is not False for value in flags.values()):
        raise AssertionError(flags)


def test_manual_review_rejects_release_claim() -> None:
    original = REVIEW.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["review_decision"]["release_claim"] = "approved"
        REVIEW.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "release claim must remain blocked" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        REVIEW.write_text(original, encoding="utf-8")


def test_manual_review_rejects_missing_nnapi_finding() -> None:
    original = REVIEW.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(original)
        data["modeled_review_findings"] = [
            item
            for item in data["modeled_review_findings"]
            if item["id"] != "npu_nnapi_evidence_blocked"
        ]
        REVIEW.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
        result = run_check()
        if result.returncode != 1:
            raise AssertionError(result.stdout)
        if "npu_nnapi_evidence_blocked" not in result.stdout:
            raise AssertionError(result.stdout)
    finally:
        REVIEW.write_text(original, encoding="utf-8")


def main() -> int:
    for test in (
        test_manual_review_checker_passes,
        test_manual_review_rejects_release_claim,
        test_manual_review_rejects_missing_nnapi_finding,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
