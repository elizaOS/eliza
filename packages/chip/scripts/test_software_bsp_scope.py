#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_software_bsp_scope.py"

spec = importlib.util.spec_from_file_location("check_software_bsp_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_software_bsp_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_software_bsp_scope
spec.loader.exec_module(check_software_bsp_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_software_bsp_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def test_valid_report_passes() -> None:
    report = check_software_bsp_scope.build_report()
    errors = check_software_bsp_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    print("PASS valid software BSP scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_software_bsp_scope.build_report()
    report["claim_boundary"] = "BSP scaffold exists"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_software_bsp_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    print("PASS release-claim flip rejected")


def test_all_target_evidence_pass_fails_until_release_claim_allows_it() -> None:
    report = check_software_bsp_scope.build_report()
    mutated = copy.deepcopy(report)
    for target in mutated["targets"]:
        target["evidence_status"] = "PASS"
    expect_error(mutated, "must not all pass")
    print("PASS all-target evidence pass rejected while release claim is false")


def test_blocker_removal_fails() -> None:
    report = check_software_bsp_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["blocked_until_real_evidence"] = ["AOSP log"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_structured_findings_cover_external_evidence_gaps() -> None:
    report = check_software_bsp_scope.build_report()
    findings = report.get("findings", [])
    if not findings:
        raise AssertionError("software BSP scope report must expose structured findings")
    prefixes = {
        "software_bsp_missing_evidence_",
        "software_bsp_invalid_evidence_",
        "software_bsp_error_",
        "software_bsp_scaffold_not_pass_",
    }
    if not any(any(str(item.get("code", "")).startswith(prefix) for prefix in prefixes) for item in findings):
        raise AssertionError(f"software BSP findings must include target blockers: {findings}")
    print("PASS structured software BSP findings cover external evidence gaps")


def test_unstructured_check_status_fails() -> None:
    report = check_software_bsp_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["checks"][0]["status"] = "maybe"
    expect_error(mutated, "status must be pass or fail")
    print("PASS unstructured check status rejected")


def test_scaffold_removal_fails() -> None:
    report = check_software_bsp_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["boot_transcript_schema"]
    expect_error(mutated, "boot_transcript_schema")
    print("PASS scaffold removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_all_target_evidence_pass_fails_until_release_claim_allows_it()
    test_blocker_removal_fails()
    test_structured_findings_cover_external_evidence_gaps()
    test_unstructured_check_status_fails()
    test_scaffold_removal_fails()


if __name__ == "__main__":
    main()
