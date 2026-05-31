#!/usr/bin/env python3
"""Check the local E1 hardware-security AI policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-hardware-security-ai-policy.yaml"
EXPECTED_SCHEMA = "eliza.hardware_security_ai_policy.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "hardware_security_policy_only_no_scanner_fuzzer_trojan_or_vulnerability_claim"
)
REQUIRED_BLOCKED_ACTIONS = {
    "run_security_scanner",
    "run_fuzzer",
    "run_trojan_detector",
    "run_llm_classifier",
    "run_rag_vulnerability_triage",
    "generate_fuzzer_program",
    "generate_exploit",
    "insert_trojan",
    "claim_vulnerability",
    "claim_no_vulnerability",
    "claim_trojan_presence",
    "claim_trojan_absence",
    "claim_release_or_tapeout_security_readiness",
    "change_rtl",
    "change_netlist",
    "import_external_security_benchmark",
    "download_security_model_weights",
    "export_e1_design_to_hosted_model",
}
REQUIRED_EXECUTION_FIELDS = {
    "human_security_reviewer",
    "reviewer_disposition",
    "license_review",
    "dual_use_review",
    "disclosure_handling_plan",
    "dependency_manifest",
    "exact_tool_revision",
    "input_rtl_or_netlist_hashes",
    "output_hashes",
    "prompt_or_query_log",
    "deterministic_replay_log",
    "generated_artifact_quarantine_path",
    "threat_model_mapping",
    "taxonomy_or_cwe_mapping",
    "regression_or_formal_followup",
}
REQUIRED_GATES = {
    "python3 scripts/check_hardware_security_ai_policy.py",
    "make hardware-security-ai-policy-check",
    "python3 scripts/ai_eda/capture_hardware_security_targets.py --run-id validation",
    "python3 scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id validation",
    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
    "make rtl-check",
    "make formal",
    "make no-hardware-action-check",
}
FALSE_CLAIM_FLAGS = {
    "security_scanner_claim_allowed": False,
    "fuzzer_claim_allowed": False,
    "trojan_detection_claim_allowed": False,
    "vulnerability_claim_allowed": False,
    "no_vulnerability_claim_allowed": False,
    "release_or_tapeout_security_claim_allowed": False,
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
        for flag, expected in FALSE_CLAIM_FLAGS.items():
            if policy.get(flag) is not expected:
                fail(errors, f"{flag} must be false")
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
            path = ROOT / path_text
            if not path.is_file() and not path.is_dir():
                fail(errors, f"missing E1 context input: {path_text}")
        roots = set(
            require_list(
                policy.get("artifact_quarantine_roots"),
                "artifact_quarantine_roots",
                errors,
            )
        )
        if "build/ai_eda/hardware_security/" not in roots:
            fail(
                errors,
                "artifact_quarantine_roots must include build/ai_eda/hardware_security/",
            )

    if errors:
        print("\n".join(errors))
        return 1
    print(
        "STATUS: PASS hardware_security_ai_policy docs/spec-db/e1-hardware-security-ai-policy.yaml"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
