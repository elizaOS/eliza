#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check_soc_optimized_work_order.py"
WORK_ORDER = ROOT / "docs/architecture-optimization/soc-optimized-operating-point.yaml"
OPT_REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"

spec = importlib.util.spec_from_file_location("check_soc_optimized_work_order", CHECKER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {CHECKER}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def test_checker_passes() -> None:
    result = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    if "matches optimizer output" not in result.stdout:
        raise AssertionError(result.stdout)


def test_work_order_drift_is_rejected() -> None:
    data = yaml.safe_load(WORK_ORDER.read_text(encoding="utf-8"))
    report = json.loads(OPT_REPORT.read_text(encoding="utf-8"))
    drifted = copy.deepcopy(data)
    drifted["selected_modeled_point"]["memory_sustained_gbps"] = 120.0

    errors = checker.check_work_order(drifted, report)

    if not any("memory_sustained_gbps" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_missing_release_blocker_is_rejected() -> None:
    data = yaml.safe_load(WORK_ORDER.read_text(encoding="utf-8"))
    report = json.loads(OPT_REPORT.read_text(encoding="utf-8"))
    drifted = copy.deepcopy(data)
    drifted["forbidden_release_use_until"] = [
        item
        for item in drifted["forbidden_release_use_until"]
        if "pd_signoff_release_check" not in item
    ]

    errors = checker.check_work_order(drifted, report)

    if not any("pd_signoff_release_check" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_robustness_drift_is_rejected() -> None:
    data = yaml.safe_load(WORK_ORDER.read_text(encoding="utf-8"))
    report = json.loads(OPT_REPORT.read_text(encoding="utf-8"))
    drifted = copy.deepcopy(data)
    drifted["robustness_summary"]["min_bandwidth_margin_gbps"] = -1.0

    errors = checker.check_work_order(drifted, report)

    if not any("robustness_summary.min_bandwidth_margin_gbps" in error for error in errors):
        raise AssertionError("\n".join(errors))


def main() -> int:
    for test in (
        test_checker_passes,
        test_work_order_drift_is_rejected,
        test_missing_release_blocker_is_rejected,
        test_robustness_drift_is_rejected,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
