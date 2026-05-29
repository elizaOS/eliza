#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_radio_sensor_pmic_scope.py"

spec = importlib.util.spec_from_file_location("check_radio_sensor_pmic_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_radio_sensor_pmic_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_radio_sensor_pmic_scope
spec.loader.exec_module(check_radio_sensor_pmic_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_radio_sensor_pmic_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_radio_sensor_pmic_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    errors = check_radio_sensor_pmic_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    assert_false_claim_flags(report)
    print("PASS valid radio/sensor/PMIC scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    report["claim_boundary"] = "product scaffold only"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    report = check_radio_sensor_pmic_scope.build_report()
    report["cellular_claim_allowed"] = True
    expect_error(report, "cellular_claim_allowed")
    print("PASS release-claim flip rejected")


def test_blocker_removal_fails() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["blocked_until_real_evidence"] = ["Wi-Fi transcript"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_structured_findings_cover_radio_sensor_pmic_blockers() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    findings = report.get("findings", [])
    if not findings:
        raise AssertionError("radio/sensor/PMIC scope report must expose structured findings")
    codes = {str(item.get("code", "")) for item in findings}
    if not any(code.startswith("radio_sensor_pmic_missing_real_evidence_") for code in codes):
        raise AssertionError(
            f"radio/sensor/PMIC findings must include missing evidence: {findings}"
        )
    print("PASS structured radio/sensor/PMIC findings cover blocked real evidence")


def test_scaffold_removal_fails() -> None:
    report = check_radio_sensor_pmic_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["pmic"]
    expect_error(mutated, "pmic")
    print("PASS scaffold removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_blocker_removal_fails()
    test_structured_findings_cover_radio_sensor_pmic_blockers()
    test_scaffold_removal_fails()


if __name__ == "__main__":
    main()
