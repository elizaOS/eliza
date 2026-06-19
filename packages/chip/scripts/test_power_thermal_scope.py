#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_power_thermal_scope.py"

spec = importlib.util.spec_from_file_location("check_power_thermal_scope", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_power_thermal_scope = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_power_thermal_scope
spec.loader.exec_module(check_power_thermal_scope)


def expect_error(report: dict, token: str) -> None:
    errors = check_power_thermal_scope.validate_report(report)
    if not any(token in error for error in errors):
        raise AssertionError(f"expected {token!r} in {errors}")


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_power_thermal_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_power_thermal_scope.build_report()
    errors = check_power_thermal_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    assert_false_claim_flags(report)
    print("PASS valid power/thermal scope report")


def test_claim_boundary_drift_fails() -> None:
    report = check_power_thermal_scope.build_report()
    report["claim_boundary"] = "power scaffold only"
    expect_error(report, "claim boundary")
    print("PASS claim boundary drift rejected")


def test_release_claim_flip_fails() -> None:
    report = check_power_thermal_scope.build_report()
    report["summary"]["release_claim_allowed"] = True
    expect_error(report, "release_claim_allowed")
    report = check_power_thermal_scope.build_report()
    report["sustained_tops_w_claim_allowed"] = True
    expect_error(report, "sustained_tops_w_claim_allowed")
    print("PASS release-claim flip rejected")


def test_blocker_removal_fails() -> None:
    report = check_power_thermal_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["blocked_until_real_evidence"] = ["power trace"]
    expect_error(mutated, "blocked real-evidence")
    print("PASS blocker removal rejected")


def test_structured_findings_cover_blocked_real_evidence() -> None:
    report = check_power_thermal_scope.build_report()
    findings = report.get("findings", [])
    if not findings:
        raise AssertionError("power/thermal scope report must expose structured findings")
    if not any(
        str(item.get("code", "")).startswith("power_thermal_missing_real_evidence_")
        for item in findings
    ):
        raise AssertionError(
            f"power/thermal findings must include missing real evidence: {findings}"
        )
    if not all(item.get("next_command") and item.get("next_commands") for item in findings):
        raise AssertionError(f"power/thermal findings must be actionable: {findings}")
    print("PASS structured power/thermal findings cover blocked real evidence")


def test_power_thermal_command_plan_is_checked() -> None:
    report = check_power_thermal_scope.build_report()
    plans = report.get("next_command_plan", [])
    if len(plans) != 1:
        raise AssertionError(f"expected one power/thermal command plan: {plans!r}")
    plan = plans[0]
    if (
        plan.get("claim_boundary")
        != check_power_thermal_scope.POWER_THERMAL_COMMAND_PLAN_CLAIM_BOUNDARY
    ):
        raise AssertionError(f"power/thermal claim boundary drifted: {plan!r}")
    command_text = "\n".join(str(item) for item in plan.get("commands", []))
    for token in (
        "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND",
        check_power_thermal_scope.MEASURED_SUSTAINED_MANIFEST,
        "check_sustained_run_evidence.py",
        "check_power_thermal_scope.py",
    ):
        if token not in command_text:
            raise AssertionError(f"power/thermal command plan missing {token!r}: {plan!r}")
    commands = report.get("next_capture_commands", {})
    if (
        commands.get("sustained_power_thermal_manifest")
        != check_power_thermal_scope.POWER_THERMAL_CAPTURE_COMMANDS[1]
    ):
        raise AssertionError(f"capture command drifted: {commands!r}")
    mutated = copy.deepcopy(report)
    mutated["next_command_plan"][0]["commands"] = ["python3 scripts/check_power_thermal_scope.py"]
    expect_error(mutated, "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND")
    print("PASS power/thermal command plan checked")


def test_failed_structural_check_fails() -> None:
    report = check_power_thermal_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["checks"][0]["status"] = "fail"
    expect_error(mutated, "structural scope check")
    print("PASS structural check failure rejected")


def test_scaffold_removal_fails() -> None:
    report = check_power_thermal_scope.build_report()
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["thermal_capture_plan"]
    expect_error(mutated, "thermal_capture_plan")
    print("PASS scaffold removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_blocker_removal_fails()
    test_structured_findings_cover_blocked_real_evidence()
    test_power_thermal_command_plan_is_checked()
    test_failed_structural_check_fails()
    test_scaffold_removal_fails()


if __name__ == "__main__":
    main()
