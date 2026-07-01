#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_security_lifecycle_scope.py"

spec = importlib.util.spec_from_file_location("check_security_lifecycle_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_security_lifecycle_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_security_lifecycle_scope
spec.loader.exec_module(check_security_lifecycle_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_security_lifecycle_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_security_lifecycle_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_security_lifecycle_scope.build_report()
    errors = check_security_lifecycle_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    assert_false_claim_flags(report)
    print("PASS valid security lifecycle scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    report["claim_boundary"] = "security scaffold only"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    report = check_security_lifecycle_scope.build_report()
    report["secure_boot_claim_allowed"] = True
    expect_error(report, "secure_boot_claim_allowed")
    print("PASS release-claim flip rejected")


def test_signed_auth_status_removal_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["current_scaffold"]["debug_auth"] = "production_signer_integrated"
    expect_error(mutated, "signed-auth status")
    print("PASS signed-auth status removal rejected")


def test_synthetic_otp_placeholder_marker_removal_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["current_scaffold"]["synthetic_otp"] = "production_otp_ready"
    expect_error(mutated, "synthetic OTP placeholder")
    print("PASS synthetic OTP placeholder marker removal rejected")


def test_blocker_removal_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["blocked_until_real_evidence"] = ["secure boot"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_placeholder_non_secret_removal_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffold"]["placeholder_non_secret"]
    expect_error(mutated, "placeholder_non_secret")
    print("PASS placeholder_non_secret label removal rejected")


def test_placeholder_non_secret_fuses_removal_fails() -> None:
    report = check_security_lifecycle_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["current_scaffold"]["placeholder_non_secret_fuses"] = []
    expect_error(mutated, "placeholder_non_secret fuse fields")
    print("PASS placeholder_non_secret fuse enumeration removal rejected")


def test_structured_findings_cover_security_blockers() -> None:
    report = check_security_lifecycle_scope.build_report()
    findings = report.get("findings")
    if not isinstance(findings, list) or not findings:
        raise AssertionError("security lifecycle findings missing")
    codes = [str(finding.get("code", "")) for finding in findings if isinstance(finding, dict)]
    if not any(code.startswith("security_lifecycle_missing_real_evidence_") for code in codes):
        raise AssertionError(codes)
    print("PASS structured security lifecycle findings cover blocked real evidence")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_signed_auth_status_removal_fails()
    test_synthetic_otp_placeholder_marker_removal_fails()
    test_blocker_removal_fails()
    test_placeholder_non_secret_removal_fails()
    test_placeholder_non_secret_fuses_removal_fails()
    test_structured_findings_cover_security_blockers()


if __name__ == "__main__":
    main()
