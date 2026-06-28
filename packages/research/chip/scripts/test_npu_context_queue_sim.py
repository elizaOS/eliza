#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIM = ROOT / "benchmarks/sim/run_npu_context_queue_sim.py"
CHECK = ROOT / "scripts/check_npu_context_queue_sim.py"


def load_check_module():
    spec = importlib.util.spec_from_file_location("check_npu_context_queue_sim", CHECK)
    if spec is None or spec.loader is None:
        raise AssertionError("failed to load context queue checker module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_report() -> dict:
    result = subprocess.run(
        [sys.executable, str(SIM), "--config", "open_2028_sota_160tops"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    return json.loads(result.stdout)


def assert_error_contains(errors: list[str], text: str) -> None:
    if not any(text in error for error in errors):
        raise AssertionError(f"missing error containing {text!r}: {errors}")


def test_valid_report_passes() -> None:
    module = load_check_module()
    errors = module.validate_report(valid_report(), context_target=8, queue_depth_target=1024)
    if errors:
        raise AssertionError(errors)


def test_claim_boundary_blocks_rtl_claims() -> None:
    module = load_check_module()
    report = valid_report()
    report["claim_boundary"] = "release_ready"

    errors = module.validate_report(report, context_target=8, queue_depth_target=1024)

    assert_error_contains(errors, "block RTL scheduler claims")


def test_rejects_starvation_gap_drift() -> None:
    module = load_check_module()
    report = valid_report()
    report["summary"] = {**report["summary"], "max_service_gap_cycles": 33}

    errors = module.validate_report(report, context_target=8, queue_depth_target=1024)

    assert_error_contains(errors, "max service gap exceeds")


def test_rejects_incomplete_context() -> None:
    module = load_check_module()
    report = copy.deepcopy(valid_report())
    report["contexts"][3]["descriptors_served"] -= 1

    errors = module.validate_report(report, context_target=8, queue_depth_target=1024)

    assert_error_contains(errors, "did not complete all descriptors")


def test_rejects_queue_depth_below_target() -> None:
    module = load_check_module()
    report = valid_report()
    report["config"] = {**report["config"], "descriptor_queue_depth": 512}

    errors = module.validate_report(report, context_target=8, queue_depth_target=1024)

    assert_error_contains(errors, "descriptor queue depth below target")


def main() -> int:
    for test in (
        test_valid_report_passes,
        test_claim_boundary_blocks_rtl_claims,
        test_rejects_starvation_gap_drift,
        test_rejects_incomplete_context,
        test_rejects_queue_depth_below_target,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
