#!/usr/bin/env python3
"""Check the local E1 power/thermal AI policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-power-thermal-ai-policy.yaml"
EXPECTED_SCHEMA = "eliza.power_thermal_ai_policy.v1"
EXPECTED_CLAIM_BOUNDARY = "power_thermal_policy_only_no_map_pdn_ir_thermal_or_power_claim"

REQUIRED_BLOCKED_ACTIONS = frozenset(
    {
        "generate_pdn",
        "change_pdn",
        "change_floorplan",
        "generate_power_map",
        "generate_thermal_map",
        "generate_ir_drop_map",
        "run_power_analysis",
        "run_thermal_analysis",
        "run_ir_drop_analysis",
        "run_tcad_device_model",
        "import_external_power_dataset",
        "download_power_model_weights",
        "export_e1_design_to_hosted_model",
        "claim_pdn_signoff",
        "claim_ir_drop_closure",
        "claim_power_savings",
        "claim_thermal_margin",
        "claim_tops_per_watt",
        "claim_release_or_tapeout_readiness",
    }
)

REQUIRED_EXECUTION_FIELDS = frozenset(
    {
        "exact_tool_revision",
        "dependency_manifest",
        "license_review",
        "process_or_technology_manifest",
        "package_board_thermal_context",
        "workload_manifest",
        "vector_or_activity_provenance",
        "input_rtl_netlist_layout_or_activity_hashes",
        "calibration_trace_manifest",
        "held_out_error_analysis",
        "deterministic_signoff_replay",
        "output_hashes",
        "generated_artifact_quarantine_path",
        "command_log",
        "human_power_thermal_reviewer",
        "reviewer_disposition",
    }
)

REQUIRED_GATES = frozenset(
    {
        "python3 scripts/check_power_thermal_ai_policy.py",
        "python3 scripts/ai_eda/capture_power_thermal_targets.py --run-id validation",
        "python3 scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation",
        "python3 scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation",
        "make power-thermal-ai-policy-check",
        "make power-thermal-evidence-check",
        "make pd-signoff-manifest-check",
        "make no-hardware-action-check",
    }
)

REQUIRED_CONTEXT_INPUTS = frozenset(
    {
        "pd/upf/e1_soc_top.upf",
        "docs/pd/rail-plan-2028.yaml",
        "docs/spec-db/process-14a-effects.yaml",
        "docs/evidence/power/pdn-signoff-gate.yaml",
    }
)

REQUIRED_QUARANTINE_ROOT = "build/ai_eda/power_thermal/"
FALSE_CLAIM_FLAGS = {
    "power_map_claim_allowed": False,
    "thermal_map_claim_allowed": False,
    "ir_drop_claim_allowed": False,
    "pdn_signoff_claim_allowed": False,
    "tops_per_watt_claim_allowed": False,
    "release_or_tapeout_claim_allowed": False,
}


def fail(message: str, errors: list[str]) -> None:
    errors.append(f"FAIL: {message}")


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be a mapping", errors)
        return {}
    return value


def require_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        fail(f"{label} must be a list", errors)
        return []
    return value


def require_set(values: Any, label: str, required: set[str], errors: list[str]) -> None:
    present = set(require_list(values, label, errors))
    missing = required - present
    if missing:
        fail(f"{label} missing: {', '.join(sorted(missing))}", errors)


def main() -> int:
    errors: list[str] = []
    if not POLICY.is_file():
        print(f"FAIL: missing {POLICY.relative_to(ROOT)}")
        return 1

    policy = require_mapping(load_yaml_object(POLICY), "policy", errors)

    if policy.get("schema") != EXPECTED_SCHEMA:
        fail("unexpected schema", errors)
    if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        fail("unsafe claim boundary", errors)
    if policy.get("status") != "DRAFT_CAPTURE_ONLY":
        fail("status must be DRAFT_CAPTURE_ONLY", errors)
    for flag, expected in FALSE_CLAIM_FLAGS.items():
        if policy.get(flag) is not expected:
            fail(f"{flag} must be false", errors)

    require_set(
        policy.get("blocked_actions"), "blocked_actions", set(REQUIRED_BLOCKED_ACTIONS), errors
    )
    require_set(
        policy.get("required_before_execution"),
        "required_before_execution",
        set(REQUIRED_EXECUTION_FIELDS),
        errors,
    )
    require_set(policy.get("promotion_gates"), "promotion_gates", set(REQUIRED_GATES), errors)

    context_inputs = set(require_list(policy.get("e1_context_inputs"), "e1_context_inputs", errors))
    for required in sorted(REQUIRED_CONTEXT_INPUTS):
        if required not in context_inputs:
            fail(f"missing E1 context input: {required}", errors)

    quarantine_roots = require_list(
        policy.get("artifact_quarantine_roots"), "artifact_quarantine_roots", errors
    )
    if REQUIRED_QUARANTINE_ROOT not in quarantine_roots:
        fail(f"artifact_quarantine_roots must include {REQUIRED_QUARANTINE_ROOT}", errors)

    if errors:
        print("\n".join(errors))
        return 1

    print("STATUS: PASS power_thermal_ai_policy docs/spec-db/e1-power-thermal-ai-policy.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
