#!/usr/bin/env python3
"""Check the local external model/corpus intake policy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-external-model-corpus-intake-policy.yaml"
EXPECTED_SCHEMA = "eliza.external_model_corpus_intake_policy.v1"
EXPECTED_CLAIM_BOUNDARY = "intake_policy_only_no_download_training_inference_or_release_use"

REQUIRED_BLOCKED_ACTIONS = {
    "download_model_weights",
    "download_dataset_payload",
    "clone_external_code_into_source",
    "run_model_inference",
    "train_or_finetune_model",
    "run_external_benchmark_eval",
    "generate_or_modify_rtl",
    "generate_or_modify_assertions",
    "generate_or_modify_layout_or_constraints",
    "export_e1_source_or_logs_to_hosted_service",
    "make_release_or_tapeout_claim",
}

REQUIRED_MANIFEST_FIELDS = {
    "source_id",
    "provider",
    "source_url",
    "api_url",
    "exact_revision",
    "declared_license",
    "license_review_owner",
    "file_manifest",
    "file_sha256",
    "quarantine_path",
    "privacy_review",
    "contamination_scan",
    "benchmark_overlap_review",
    "deterministic_gates",
    "reviewer_disposition",
}

REQUIRED_EVAL_REQUIREMENTS = {
    "held_out_task_manifest",
    "prompt_hashes",
    "output_hashes",
    "no_hardware_action_review",
    "lint_log",
    "synthesis_log",
    "simulation_log",
    "formal_log",
}

REQUIRED_GATES = {
    "python3 scripts/check_external_model_corpus_intake_policy.py",
    "make external-model-corpus-intake-policy-check",
    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
    "make no-hardware-action-check",
    "make docs-check",
}

REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "download_claim_allowed",
    "inference_claim_allowed",
    "training_claim_allowed",
    "rtl_generation_claim_allowed",
    "hosted_service_claim_allowed",
    "tapeout_claim_allowed",
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
    have = set(require_list(values, label, errors))
    missing = sorted(required - have)
    if missing:
        fail(errors, f"{label} missing: {', '.join(missing)}")


def check_provider_requirements(policy: dict[str, Any], errors: list[str]) -> None:
    requirements = require_mapping(
        policy.get("provider_requirements"), "provider_requirements", errors
    )
    for provider, value in requirements.items():
        if value is not True:
            fail(errors, f"provider_requirements.{provider} must be true")


def main() -> int:
    errors: list[str] = []
    if not POLICY.is_file():
        fail(errors, f"missing {POLICY.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    policy = require_mapping(yaml.safe_load(POLICY.read_text()), "policy", errors)
    if policy.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        fail(errors, "unsafe claim boundary")
    if policy.get("status") != "DRAFT_CAPTURE_ONLY":
        fail(errors, "status must be DRAFT_CAPTURE_ONLY")
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if policy.get(key) is not False:
            fail(errors, f"{key} must be false")

    require_set(
        policy.get("blocked_actions"),
        "blocked_actions",
        REQUIRED_BLOCKED_ACTIONS,
        errors,
    )
    require_set(
        policy.get("required_manifest_fields"),
        "required_manifest_fields",
        REQUIRED_MANIFEST_FIELDS,
        errors,
    )
    require_set(
        policy.get("local_e1_eval_requirements"),
        "local_e1_eval_requirements",
        REQUIRED_EVAL_REQUIREMENTS,
        errors,
    )
    require_set(
        policy.get("promotion_gates"),
        "promotion_gates",
        REQUIRED_GATES,
        errors,
    )

    quarantine_roots = set(require_list(policy.get("quarantine_roots"), "quarantine_roots", errors))
    if "build/ai_eda/external_assets/" not in quarantine_roots:
        fail(errors, "quarantine_roots must include build/ai_eda/external_assets/")

    check_provider_requirements(policy, errors)

    if errors:
        print("\n".join(errors))
        return 1
    print(
        "STATUS: PASS external_model_corpus_intake_policy "
        "docs/spec-db/e1-external-model-corpus-intake-policy.yaml"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
