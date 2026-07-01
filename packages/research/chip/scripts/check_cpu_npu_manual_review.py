#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml
from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / "docs/architecture-optimization/cpu-npu-2028-manual-review.yaml"
OPTIMIZER = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
SCORECARD_CHECK = ROOT / "scripts/check_cpu_npu_2028_readiness_scorecard.py"

REQUIRED_FINDINGS = {
    "modeled_operating_point_pass": "pass",
    "modeled_power_thermal_pass": "pass",
    "modeled_memory_margin_pass": "pass",
    "robustness_guardband_pass": "pass",
    "modeled_benchmark_harness_pass": "pass",
    "modeled_sota_npu_eval_pass": "pass",
    "modeled_burst_sustained_policy_pass": "pass",
    "modeled_burst_thermal_transient_pass": "pass",
    "modeled_aosp_governor_trace_pass": "pass",
    "modeled_14a_process_eval_pass": "pass",
    "modeled_competitive_envelope_pass": "pass",
    "modeled_tapeout_readiness_audit_pass": "pass",
    "cpu_ap_evidence_blocked": "blocked",
    "npu_nnapi_evidence_blocked": "blocked",
    "aosp_simulator_evidence_blocked": "blocked",
    "benchmark_release_blocked": "blocked",
    "sustained_power_thermal_blocked": "blocked",
    "memory_uma_blocked": "blocked",
    "process_pdk_blocked": "blocked",
    "physical_signoff_blocked": "blocked",
}
REQUIRED_RELEASE_GATES = {
    "make cpu-ap-completion-gate",
    "make e1-npu-nnapi-proof-check",
    "make aosp-simulator-completion-check",
    "make benchmarks",
    "make power-thermal-evidence-check",
    "make memory-uma-claim-gate",
    "make process-14a-effects-check",
    "make pd-signoff-check",
}

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "target_benchmark_claim_allowed": False,
    "aosp_runtime_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "post_route_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def run_scorecard_check(errors: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, str(SCORECARD_CHECK)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        errors.append(f"scorecard check failed:\n{result.stdout}")


def number_matches(left: Any, right: Any, field: str, errors: list[str]) -> None:
    if not isinstance(left, int | float) or isinstance(left, bool):
        errors.append(f"{field} must be numeric in review")
        return
    if not isinstance(right, int | float) or isinstance(right, bool):
        errors.append(f"{field} must be numeric in optimizer report")
        return
    if abs(float(left) - float(right)) > 1e-9:
        errors.append(f"{field} drifted: review={left}, optimizer={right}")


def check_selected_point(
    review: dict[str, Any], optimizer: dict[str, Any], errors: list[str]
) -> None:
    selected = review.get("selected_modeled_point")
    optimized = optimizer.get("optimized")
    if not isinstance(selected, dict):
        errors.append("selected_modeled_point must be a mapping")
        return
    if not isinstance(optimized, dict) or not isinstance(optimized.get("config"), dict):
        errors.append("optimizer report missing optimized config")
        return
    config = optimized["config"]
    for key in (
        "cpu_cores",
        "cpu_base_frequency_hz",
        "cpu_base_ipc",
        "cpu_base_power_w",
        "npu_base_tops",
        "npu_base_power_w",
        "memory_sustained_gbps",
    ):
        number_matches(selected.get(key), config.get(key), f"selected_modeled_point.{key}", errors)


def check_findings(review: dict[str, Any], optimizer: dict[str, Any], errors: list[str]) -> None:
    findings = review.get("modeled_review_findings")
    if not isinstance(findings, list):
        errors.append("modeled_review_findings must be a list")
        return
    by_id = {item.get("id"): item for item in findings if isinstance(item, dict)}
    missing = sorted(set(REQUIRED_FINDINGS) - set(by_id))
    require(not missing, "missing review findings: " + ", ".join(missing), errors)
    for finding_id, expected_status in REQUIRED_FINDINGS.items():
        item = by_id.get(finding_id)
        if not isinstance(item, dict):
            continue
        require(
            item.get("status") == expected_status,
            f"{finding_id} status must be {expected_status}",
            errors,
        )
        require(
            isinstance(item.get("evidence"), str) and len(item["evidence"]) >= 20,
            f"{finding_id} must have review evidence text",
            errors,
        )
    gates = {
        item.get("release_gate")
        for item in findings
        if isinstance(item, dict) and item.get("status") == "blocked"
    }
    missing_gates = sorted(REQUIRED_RELEASE_GATES - gates)
    require(not missing_gates, "missing release gates: " + ", ".join(missing_gates), errors)

    optimized = optimizer.get("optimized")
    robustness = optimizer.get("robustness")
    summary = optimized.get("summary", {}) if isinstance(optimized, dict) else {}
    robust_summary = robustness.get("summary", {}) if isinstance(robustness, dict) else {}
    require(
        isinstance(summary, dict) and summary.get("any_modeled_throttle_required") is False,
        "optimizer must remain no-throttle for review pass finding",
        errors,
    )
    if isinstance(summary, dict):
        require(
            float(summary.get("max_die_temp_c", 999.0)) <= 95.0,
            "reviewed modeled point exceeds thermal limit",
            errors,
        )
        require(
            float(summary.get("max_total_power_w", 999.0)) <= 5.0,
            "reviewed modeled point exceeds mobile power budget",
            errors,
        )
        require(
            float(summary.get("min_bandwidth_margin_gbps", -999.0)) > 0.0,
            "reviewed modeled point lacks nominal bandwidth margin",
            errors,
        )
    require(
        isinstance(robust_summary, dict) and robust_summary.get("pass") is True,
        "reviewed robustness guardband must pass",
        errors,
    )


def check_decision(review: dict[str, Any], errors: list[str]) -> None:
    decision = review.get("review_decision")
    if not isinstance(decision, dict):
        errors.append("review_decision must be a mapping")
        return
    require(
        decision.get("modeled_recommendation") == "approve_for_next_implementation_step",
        "modeled recommendation decision drifted",
        errors,
    )
    require(decision.get("release_claim") == "blocked", "release claim must remain blocked", errors)
    blockers = decision.get("release_claim_forbidden_until")
    require(
        isinstance(blockers, list) and len(blockers) >= 7,
        "review decision must list release blockers",
        errors,
    )
    blocker_text = "\n".join(str(item) for item in blockers or [])
    for token in (
        "cpu_ap_evidence_blocked",
        "npu_nnapi_evidence_blocked",
        "aosp_simulator_evidence_blocked",
        "benchmark_release_blocked",
        "sustained_power_thermal_blocked",
        "memory_uma_blocked",
        "process_pdk_blocked",
        "physical_signoff_blocked",
    ):
        require(token in blocker_text, f"release decision missing blocker {token}", errors)


def check_review(review: dict[str, Any], optimizer: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        review.get("schema") == "eliza.cpu_npu_2028_manual_review.v1",
        "review schema mismatch",
        errors,
    )
    require(
        review.get("status") == "modeled_review_release_blocked",
        "review status must remain modeled_review_release_blocked",
        errors,
    )
    require(
        "not AOSP" in str(review.get("claim_boundary", "")),
        "claim boundary must block AOSP evidence use",
        errors,
    )
    require(
        "phone-class" in str(review.get("claim_boundary", "")),
        "claim boundary must block phone-class claims",
        errors,
    )
    for flag in FALSE_CLAIM_FLAGS:
        require(review.get(flag) is False, f"{flag} must be exactly false", errors)
    check_selected_point(review, optimizer, errors)
    check_findings(review, optimizer, errors)
    check_decision(review, errors)
    return errors


def main() -> int:
    errors: list[str] = []
    run_scorecard_check(errors)
    try:
        errors.extend(check_review(load_yaml_object(REVIEW), load_json_object(OPTIMIZER)))
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        errors.append(str(exc))
    if errors:
        print("CPU+NPU 2028 manual review check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("CPU+NPU 2028 manual review passed: modeled recommendation remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
