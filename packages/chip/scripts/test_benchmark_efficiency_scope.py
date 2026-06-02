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
    if not all(item.get("next_command") for item in findings):
        raise AssertionError(
            f"benchmark efficiency findings must include row-level commands: {findings}"
        )
    joined = "\n".join(findings[0].get("next_commands", []))
    for token in (
        "benchmarks/run_benchmarks.py run",
        "capture_e1_npu_nnapi_evidence.sh",
        "E1_NPU_CPU_FALLBACK_PERCENT=0",
        "E1_NPU_UNSUPPORTED_OP_COUNT=0",
        "capture_cpu_ap_evidence.py intake ap-benchmarks",
        "check_benchmark_efficiency_scope.py",
    ):
        if token not in joined:
            raise AssertionError(f"benchmark finding commands missing {token!r}: {joined}")
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
    mutated = copy.deepcopy(report)
    del mutated["current_scaffolds"]["target_metadata_contract"]
    expect_error(mutated, "target_metadata_contract")
    print("PASS scaffold removal rejected")


def test_target_metadata_contract_is_required() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    checks = {item.get("id"): item for item in report.get("checks", [])}
    check = checks.get("target_metadata_contract_matches_runner_requirements")
    if not isinstance(check, dict) or check.get("status") != "pass":
        raise AssertionError(f"target metadata contract check did not pass: {check!r}")
    if check.get("evidence") != "benchmarks/configs/target-metadata.contract.json":
        raise AssertionError(f"target metadata contract evidence drifted: {check!r}")
    mutated = copy.deepcopy(report)
    for item in mutated["checks"]:
        if item.get("id") == "target_metadata_contract_matches_runner_requirements":
            item["status"] = "fail"
            break
    expect_error(mutated, "target_metadata_contract_matches_runner_requirements")
    print("PASS target metadata contract required")


def test_accepted_generated_ap_benchmark_evidence_is_reported() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    accepted = report.get("accepted_generated_ap_benchmark_evidence")
    if not isinstance(accepted, dict) or accepted.get("accepted") is not True:
        raise AssertionError(f"accepted generated-AP benchmark evidence missing: {accepted!r}")
    checks = {item.get("id"): item for item in report.get("checks", [])}
    check = checks.get("generated_ap_l3_benchmark_evidence_is_intaken")
    if not isinstance(check, dict) or check.get("status") != "pass":
        raise AssertionError(f"generated AP benchmark intake check did not pass: {check!r}")
    boundary = str(check.get("claim_boundary", ""))
    for token in ("not calibrated L5/L6", "not calibrated", "phone efficiency", "TOPS/W"):
        if token not in boundary:
            raise AssertionError(f"benchmark intake claim boundary missing {token!r}: {boundary}")
    mutated = copy.deepcopy(report)
    mutated["accepted_generated_ap_benchmark_evidence"]["accepted"] = False
    expect_error(mutated, "accepted generated-AP benchmark evidence")
    print("PASS accepted generated-AP benchmark evidence reported")


def test_capture_command_removal_fails() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    commands = report.get("next_capture_commands", {})
    required = check_benchmark_efficiency_scope.REQUIRED_CAPTURE_COMMANDS
    if commands != required:
        raise AssertionError(f"capture commands drifted: {commands!r}")
    target_command = commands.get("target_benchmark_report", "")
    if "--metadata benchmarks/results/target-phone/target-metadata.json" not in target_command:
        raise AssertionError(f"target benchmark command must use runner --metadata: {target_command}")
    if "--target-metadata" in target_command:
        raise AssertionError(f"target benchmark command uses obsolete flag: {target_command}")
    npu_command = commands.get("npu_nnapi_proof", "")
    for token in (
        "E1_NPU_MACS_PER_INFERENCE=<measured-macs>",
        "E1_NPU_NNAPI_DELEGATED_NODE_COUNT=<measured-delegated-nodes>",
        "E1_NPU_CPU_FALLBACK_PERCENT=0",
        "E1_NPU_UNSUPPORTED_OP_COUNT=0",
    ):
        if token not in npu_command:
            raise AssertionError(f"NNAPI proof command missing {token!r}: {npu_command}")
    mutated = copy.deepcopy(report)
    del mutated["next_capture_commands"]["npu_nnapi_proof"]
    expect_error(mutated, "npu_nnapi_proof")
    print("PASS capture command removal rejected")


def test_generated_ap_benchmark_command_plan_is_checked() -> None:
    report = check_benchmark_efficiency_scope.build_report()
    plans = report.get("next_command_plan", [])
    if len(plans) != 1:
        raise AssertionError(f"expected one generated-AP command plan: {plans!r}")
    plan = plans[0]
    if plan.get("claim_boundary") != check_benchmark_efficiency_scope.GENERATED_AP_CLAIM_BOUNDARY:
        raise AssertionError(f"generated-AP claim boundary drifted: {plan!r}")
    command_text = "\n".join(str(item) for item in plan.get("commands", []))
    for snippet in check_benchmark_efficiency_scope.REQUIRED_GENERATED_AP_CAPTURE_SNIPPETS:
        if snippet not in command_text:
            raise AssertionError(f"generated-AP command plan missing {snippet!r}: {plan!r}")
    mutated = copy.deepcopy(report)
    mutated["next_command_plan"][0]["commands"] = ["scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh"]
    expect_error(mutated, "capture_cpu_ap_evidence.py intake ap-benchmarks")
    print("PASS generated-AP benchmark command plan checked")


def main() -> None:
    test_valid_report_passes()
    test_claim_boundary_drift_fails()
    test_release_claim_flip_fails()
    test_blocker_removal_fails()
    test_structured_findings_cover_blocked_real_evidence()
    test_failed_structural_check_fails()
    test_scaffold_removal_fails()
    test_target_metadata_contract_is_required()
    test_accepted_generated_ap_benchmark_evidence_is_reported()
    test_capture_command_removal_fails()
    test_generated_ap_benchmark_command_plan_is_checked()


if __name__ == "__main__":
    main()
