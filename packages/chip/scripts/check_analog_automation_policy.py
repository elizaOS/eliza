#!/usr/bin/env python3
"""Check the local E1 analog automation policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-analog-automation-policy.yaml"
EXPECTED_SCHEMA = "eliza.analog_automation_policy.v1"
EXPECTED_CLAIM_BOUNDARY = "analog_policy_only_no_spice_layout_ip_or_signoff_claim"

REQUIRED_BLOCKED_ACTIONS = {
    "generate_spice_netlist",
    "generate_schematic",
    "generate_verilog_a_model",
    "generate_layout",
    "run_spice_simulation",
    "run_drc_lvs_extraction",
    "select_foundry_ip",
    "download_analog_model_weights",
    "import_analog_dataset_payload",
    "export_e1_design_to_hosted_model",
    "change_padframe",
    "change_package_pinout",
    "claim_analog_performance",
    "claim_si_pi_closure",
    "claim_tapeout_or_release_readiness",
}
REQUIRED_EXECUTION_FIELDS = {
    "exact_tool_revision",
    "pdk_or_model_provenance",
    "input_spec_hash",
    "dependency_manifest",
    "command_log",
    "output_hashes",
    "convergence_log",
    "pvt_corner_manifest",
    "drc_lvs_extraction_report",
    "generated_artifact_quarantine_path",
    "package_or_board_context",
    "license_review",
    "human_analog_reviewer",
    "reviewer_disposition",
}
REQUIRED_GATES = {
    "python3 scripts/check_analog_automation_policy.py",
    "python3 scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation",
    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
    "make analog-automation-policy-check",
    "make padframe-check",
    "make board-package-evidence-check",
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
        policy = require_mapping(yaml.safe_load(POLICY.read_text()), "policy", errors)
        if policy.get("schema") != EXPECTED_SCHEMA:
            fail(errors, "unexpected schema")
        if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
            fail(errors, "unsafe claim boundary")
        if policy.get("status") != "DRAFT_CAPTURE_ONLY":
            fail(errors, "status must be DRAFT_CAPTURE_ONLY")
        require_set(
            policy.get("blocked_actions"), "blocked_actions", REQUIRED_BLOCKED_ACTIONS, errors
        )
        require_set(
            policy.get("required_before_execution"),
            "required_before_execution",
            REQUIRED_EXECUTION_FIELDS,
            errors,
        )
        require_set(policy.get("promotion_gates"), "promotion_gates", REQUIRED_GATES, errors)
        roots = require_list(policy.get("e1_context_inputs"), "e1_context_inputs", errors)
        for path_text in roots:
            if not isinstance(path_text, str):
                fail(errors, "e1_context_inputs entries must be strings")
            elif not (ROOT / path_text).is_file():
                fail(errors, f"missing E1 context input: {path_text}")
        quarantine = set(
            require_list(
                policy.get("artifact_quarantine_roots"), "artifact_quarantine_roots", errors
            )
        )
        if "build/ai_eda/analog_mixed_signal/" not in quarantine:
            fail(
                errors,
                "artifact_quarantine_roots must include build/ai_eda/analog_mixed_signal/",
            )

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS analog_automation_policy docs/spec-db/e1-analog-automation-policy.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
