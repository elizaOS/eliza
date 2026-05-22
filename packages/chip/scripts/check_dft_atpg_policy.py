#!/usr/bin/env python3
"""Check the local E1 DFT/ATPG policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-dft-atpg-policy.yaml"
EXPECTED_SCHEMA = "eliza.dft_atpg_policy.v1"
EXPECTED_CLAIM_BOUNDARY = "dft_atpg_policy_only_no_scan_atpg_mbist_or_fault_coverage_claim"
REQUIRED_BLOCKED_ACTIONS = {
    "insert_scan",
    "insert_test_points",
    "run_atpg",
    "run_fault_simulation",
    "generate_test_patterns",
    "generate_mbist_wrapper",
    "generate_bisr_repair_collateral",
    "claim_fault_coverage",
    "claim_test_coverage",
    "claim_manufacturing_test_readiness",
    "claim_release_or_tapeout_readiness",
    "change_rtl",
    "change_netlist",
    "import_external_dft_dataset",
    "download_dft_model_weights",
    "export_e1_design_to_hosted_model",
}
REQUIRED_EXECUTION_FIELDS = {
    "human_dft_reviewer",
    "reviewer_disposition",
    "license_review",
    "dependency_manifest",
    "exact_tool_revision",
    "input_rtl_or_netlist_hashes",
    "output_hashes",
    "command_log",
    "generated_artifact_quarantine_path",
    "scan_architecture_manifest",
    "fault_model_manifest",
    "accepted_netlist_subset",
    "test_mode_io_contract",
    "deterministic_atpg_baseline",
    "manufacturing_test_context",
    "regression_or_formal_followup",
    "timing_power_area_followup",
}
REQUIRED_GATES = {
    "python3 scripts/check_dft_atpg_policy.py",
    "make dft-atpg-policy-check",
    "python3 scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation",
    "python3 scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation",
    "make rtl-check",
    "make formal",
    "make manufacturing-artifacts-check",
    "make no-hardware-action-check",
}


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(errors, f"{label} must be a mapping")
        return {}
    return value


def require_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        fail(errors, f"{label} must be a list")
        return []
    return value


def require_set(values: Any, label: str, required: set[str], errors: list[str]) -> None:
    observed = set(require_list(values, label, errors))
    missing = sorted(required - observed)
    if missing:
        fail(errors, f"{label} missing: {', '.join(missing)}")


def main() -> int:
    errors: list[str] = []
    if not POLICY.is_file():
        fail(errors, f"missing {POLICY.relative_to(ROOT)}")
    else:
        policy = require_mapping(load_yaml_object(POLICY), "policy", errors)
        if policy.get("schema") != EXPECTED_SCHEMA:
            fail(errors, "unexpected schema")
        if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
            fail(errors, "unsafe claim boundary")
        if policy.get("status") != "DRAFT_CAPTURE_ONLY":
            fail(errors, "status must be DRAFT_CAPTURE_ONLY")
        require_set(
            policy.get("blocked_actions"),
            "blocked_actions",
            REQUIRED_BLOCKED_ACTIONS,
            errors,
        )
        require_set(
            policy.get("required_before_execution"),
            "required_before_execution",
            REQUIRED_EXECUTION_FIELDS,
            errors,
        )
        require_set(
            policy.get("promotion_gates"),
            "promotion_gates",
            REQUIRED_GATES,
            errors,
        )
        for path_text in require_list(policy.get("e1_context_inputs"), "e1_context_inputs", errors):
            if not isinstance(path_text, str):
                continue
            if not (ROOT / path_text).is_file():
                fail(errors, f"missing E1 context input: {path_text}")
        roots = set(
            require_list(
                policy.get("artifact_quarantine_roots"),
                "artifact_quarantine_roots",
                errors,
            )
        )
        if "build/ai_eda/dft_atpg/" not in roots:
            fail(errors, "artifact_quarantine_roots must include build/ai_eda/dft_atpg/")

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS dft_atpg_policy docs/spec-db/e1-dft-atpg-policy.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
