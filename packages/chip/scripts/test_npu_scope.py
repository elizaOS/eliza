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


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_npu_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_npu_scope.build_report()
    errors = check_npu_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    assert_false_claim_flags(report)
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
    report = check_npu_scope.build_report()
    report["nnapi_accelerator_claim_allowed"] = True
    expect_error(report, "nnapi_accelerator_claim_allowed")
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


def test_structured_findings_cover_required_real_evidence() -> None:
    report = check_npu_scope.build_report()
    findings = report.get("findings", [])
    if not findings:
        raise AssertionError("NPU scope report must expose structured findings")
    if not any(
        str(item.get("code", "")).startswith("npu_missing_real_evidence_") for item in findings
    ):
        raise AssertionError(f"NPU findings must include missing real evidence: {findings}")
    if not all(item.get("next_command") for item in findings):
        raise AssertionError(f"NPU findings must include row-level commands: {findings}")
    joined = "\n".join(
        command
        for batch in report.get("next_command_plan", [])
        for command in batch.get("commands", [])
    )
    for token in (
        "capture_e1_npu_nnapi_evidence.sh",
        "check_e1_npu_nnapi_proof.py --probe-adb",
        "capture_e1_npu_android_proof_bundle.sh",
    ):
        if token not in joined:
            raise AssertionError(f"NPU finding commands missing {token!r}: {joined}")
    print("PASS structured NPU findings cover required real evidence")


def test_structured_findings_use_specific_capture_commands() -> None:
    report = check_npu_scope.build_report()
    findings = report.get("findings", [])
    by_message = {str(item.get("message")): item for item in findings}

    nnapi = by_message["NNAPI accelerator query transcript lists e1-npu"]
    if "capture_e1_npu_nnapi_evidence.sh" not in "\n".join(nnapi.get("next_commands", [])):
        raise AssertionError(nnapi)
    if "capture_e1_npu_nnapi_evidence.sh" not in nnapi.get("next_command", ""):
        raise AssertionError(f"NNAPI proof finding used generic command: {nnapi}")

    android = by_message[
        "Android proof manifest contains passing VTS, CTS, VINTF, SELinux, NNAPI query, and fail-closed absent-device artifacts"
    ]
    android_commands = "\n".join(android.get("next_commands", []))
    if "capture_e1_npu_android_proof_bundle.sh" not in android_commands:
        raise AssertionError(android)
    if android.get("next_command") == "adb devices":
        raise AssertionError(f"Android proof finding used generic adb command: {android}")

    power = by_message[
        "power/thermal manifest contains calibrated sustained workload traces and computed perf-per-watt"
    ]
    power_commands = "\n".join(power.get("next_commands", []))
    if "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND" not in power_commands:
        raise AssertionError(power)
    for token in (
        "e1-npu-sustained-capture.measured.json",
        "check_sustained_run_evidence.py",
        "check_power_thermal_scope.py",
    ):
        if token not in power_commands:
            raise AssertionError(f"Power finding commands missing {token!r}: {power}")
    if power.get("next_command") == "adb devices":
        raise AssertionError(f"Power finding used generic adb command: {power}")
    print("PASS structured NPU findings use specific capture commands")


def test_next_command_plan_covers_target_side_npu_capture() -> None:
    report = check_npu_scope.build_report()
    errors = check_npu_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    plan = report.get("next_command_plan", [])
    if not plan:
        raise AssertionError("missing NPU next_command_plan")
    command_text = "\n".join(
        command
        for batch in plan
        for command in batch.get("commands", [])
    )
    for token in (
        "capture_e1_npu_nnapi_evidence.sh",
        "check_e1_npu_nnapi_proof.py --probe-adb",
        "check_e1_npu_android_proof_manifest.py",
        "check_sustained_run_evidence.py",
        "check_power_thermal_scope.py",
        'test -n "$CHIP_ANDROID_ADB_SERIAL" || test -n "$CHIP_ANDROID_ADB_HOSTPORT"',
        'ANDROID_SERIAL="${CHIP_ANDROID_ADB_SERIAL:-$CHIP_ANDROID_ADB_HOSTPORT}"',
    ):
        if token not in command_text:
            raise AssertionError(command_text)
    if "\nadb devices\n" in f"\n{command_text}\n":
        raise AssertionError(f"NPU next-command plan used generic adb discovery: {command_text}")
    print("PASS NPU next-command plan covers target-side capture")


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
    test_structured_findings_cover_required_real_evidence()
    test_structured_findings_use_specific_capture_commands()
    test_next_command_plan_covers_target_side_npu_capture()
    test_failed_structural_check_fails()
    test_scaffold_removal_fails()


if __name__ == "__main__":
    main()
