#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_benchmark_efficiency_scope.py"

spec = importlib.util.spec_from_file_location("check_benchmark_efficiency_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_benchmark_efficiency_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_benchmark_efficiency_scope
spec.loader.exec_module(check_benchmark_efficiency_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_benchmark_efficiency_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_benchmark_efficiency_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    errors = check_benchmark_efficiency_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    assert_false_claim_flags(report)
    print("PASS valid benchmark efficiency scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    report["claim_boundary"] = "benchmark harness exists"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    report = check_benchmark_efficiency_scope.build_report()
    report["measured_tops_w_claim_allowed"] = True
    expect_error(report, "measured_tops_w_claim_allowed")
    print("PASS release-claim flip rejected")


def test_blocker_removal_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["blocked_until_real_evidence"] = ["benchmarks pass"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_structured_findings_cover_blocked_real_evidence() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    findings = report.get("findings", [])
    if not findings:
        raise AssertionError("benchmark efficiency scope report must expose structured findings")
    if not any(
        str(item.get("code", "")).startswith("benchmark_efficiency_missing_real_evidence_")
        for item in findings
    ):
        raise AssertionError(
            f"benchmark efficiency findings must include missing real evidence: {findings}"
        )
    print("PASS structured benchmark efficiency findings cover blocked real evidence")


def test_failed_structural_check_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["checks"][0]["status"] = "fail"
    expect_error(mutated, "structural scope check")
    print("PASS structural check failure rejected")


def test_scaffold_removal_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["runner"]
    expect_error(mutated, "runner")
    print("PASS scaffold removal rejected")


def test_capture_command_removal_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    commands = report.get("next_capture_commands", {})
    required = check_benchmark_efficiency_scope.REQUIRED_CAPTURE_COMMANDS
    if commands != required:
        raise AssertionError(f"capture commands drifted: {commands!r}")
    mutated = copy.deepcopy(report)
    del mutated["next_capture_commands"]["npu_nnapi_proof"]
    expect_error(mutated, "npu_nnapi_proof")
    print("PASS capture command removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_blocker_removal_fails()
    test_structured_findings_cover_blocked_real_evidence()
    test_failed_structural_check_fails()
    test_scaffold_removal_fails()
    test_capture_command_removal_fails()


if __name__ == "__main__":
    main()
