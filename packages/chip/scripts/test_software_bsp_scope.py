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


def assert_false_claim_flags(report: dict) -> None:
    for key, expected in check_software_bsp_scope.FALSE_CLAIM_FLAGS.items():
        if report.get(key) is not expected:
            raise AssertionError(f"{key} must be {expected!r}: {report.get(key)!r}")


def test_valid_report_passes() -> None:
    report = check_software_bsp_scope.build_report()
    errors = check_software_bsp_scope.validate_report(report)
    if errors:
        raise AssertionError(errors)
    targets = {target.get("target") for target in report["targets"]}
    if "u-boot" in targets:
        raise AssertionError(
            f"selected software BSP scope must not require alternate U-Boot target: {targets}"
        )
    assert_false_claim_flags(report)
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
    report = check_software_bsp_scope.build_report()
    report["android_boot_claim_allowed"] = True
    expect_error(report, "android_boot_claim_allowed")
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


def test_uboot_capture_plan_is_release_scoped() -> None:
    report = check_software_bsp_scope.build_report()
    check = next(
        item
        for item in report["checks"]
        if item["id"] == "capture_plans_cover_external_build_boot_and_runtime_evidence"
    )
    if check["status"] != "pass":
        raise AssertionError(check)
    blockers = "\n".join(report["blocked_until_real_evidence"])
    if "if U-Boot is selected for production boot" not in blockers:
        raise AssertionError(blockers)
    print("PASS U-Boot capture plan and blockers covered")


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
    if not any(
        any(str(item.get("code", "")).startswith(prefix) for prefix in prefixes)
        for item in findings
    ):
        raise AssertionError(f"software BSP findings must include target blockers: {findings}")
    print("PASS structured software BSP findings cover external evidence gaps")


def test_next_command_plan_covers_blocked_aosp_evidence() -> None:
    report = check_software_bsp_scope.build_report()
    commands = report.get("next_command_plan", [])
    aosp_batch = next(
        (
            item
            for item in commands
            if item.get("id") == "capture_aosp_software_bsp_external_evidence"
        ),
        None,
    )
    if not aosp_batch:
        raise AssertionError(f"missing AOSP command batch: {commands}")
    if aosp_batch.get("claim_boundary") != "operator_commands_only_not_software_bsp_evidence":
        raise AssertionError(aosp_batch)
    joined = "\n".join(aosp_batch.get("commands", []))
    for token in (
        "sw/aosp-device/import-aosp-device.sh --check /path/to/aosp",
        "sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage",
        "sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-smoke",
        "AOSP_QEMU_SMOKE_COMMAND='/exact/qemu-system-riscv64 smoke command'",
        "AOSP_RENODE_SMOKE_COMMAND='/exact/renode smoke command'",
        "python3 scripts/check_software_bsp.py aosp --require-evidence",
    ):
        if token not in joined:
            raise AssertionError(f"missing {token!r} in {joined}")
    aosp_findings = [
        finding
        for finding in report.get("findings", [])
        if finding.get("target") == "aosp"
    ]
    if not aosp_findings:
        raise AssertionError("missing AOSP structured findings")
    if not all(finding.get("next_command") for finding in aosp_findings):
        raise AssertionError(f"AOSP findings must include row-level commands: {aosp_findings}")
    first_commands = "\n".join(aosp_findings[0].get("next_commands", []))
    if "sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage" not in first_commands:
        raise AssertionError(first_commands)
    print("PASS next-command plan covers blocked AOSP evidence")


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


def test_next_command_plan_removal_fails() -> None:
    report = check_software_bsp_scope.build_report()
    mutated = copy.deepcopy(report)
    mutated["next_command_plan"] = []
    expect_error(mutated, "next_command_plan")
    print("PASS next-command plan removal rejected")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_all_target_evidence_pass_fails_until_release_claim_allows_it()
    test_blocker_removal_fails()
    test_uboot_capture_plan_is_release_scoped()
    test_structured_findings_cover_external_evidence_gaps()
    test_next_command_plan_covers_blocked_aosp_evidence()
    test_unstructured_check_status_fails()
    test_scaffold_removal_fails()
    test_next_command_plan_removal_fails()


if __name__ == "__main__":
    main()
