#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_npu_scope.py"

spec = importlib.util.spec_from_file_location("check_npu_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_npu_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_npu_scope
spec.loader.exec_module(check_npu_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_npu_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def test_valid_report_passes() -> None:
    report = check_npu_scope.build_report()
    errors = check_npu_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    print("PASS valid NPU scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_npu_scope.build_report()
    report["claim_boundary"] = "NPU proof exists"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_npu_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    print("PASS release-claim flip rejected")


def test_phone_claim_flip_fails() -> None:
    report = check_npu_scope.build_report()
    report["summary"]["phone_2028_claim_allowed"] = True
    expect_error(report, "phone_2028_claim_allowed")
    print("PASS phone-class claim flip rejected")


def test_current_level_promotion_fails() -> None:
    report = check_npu_scope.build_report()
    report["summary"]["current_npu_level"] = "L5_2028_PHONE_CLASS_EVIDENCE"
    expect_error(report, "current_npu_level")
    print("PASS current-level promotion rejected")


def test_blocker_removal_fails() -> None:
    report = check_npu_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["required_real_evidence"] = ["benchmark_model transcript"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_failed_structural_check_fails() -> None:
    report = check_npu_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["checks"][0]["status"] = "fail"
    expect_error(mutated, "structural scope check")
    print("PASS structural check failure rejected")


def test_scaffold_removal_fails() -> None:
    report = check_npu_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["nnapi_proof_checker"]
    expect_error(mutated, "nnapi_proof_checker")
    print("PASS scaffold removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_phone_claim_flip_fails()
    test_current_level_promotion_fails()
    test_blocker_removal_fails()
    test_failed_structural_check_fails()
    test_scaffold_removal_fails()


if __name__ == "__main__":
    main()
