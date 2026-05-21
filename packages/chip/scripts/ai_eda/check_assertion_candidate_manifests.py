#!/usr/bin/env python3
"""Validate quarantined AI-EDA assertion-candidate manifests."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST_DIR = ROOT / "verify/ai_eda/assertion_candidates"
EXPECTED_SCHEMA = "eliza.ai_eda.assertion_candidate_manifest.v1"
EXPECTED_CLAIM_BOUNDARY = "assertion_candidates_only_no_rtl_bind_formal_pass_or_release_claim"
CLAIM_BOUNDARY = "assertion_candidate_validation_only_no_rtl_bind_formal_or_release_claim"
REQUIRED_CANDIDATE_FIELDS = (
    "id",
    "status",
    "module",
    "clock",
    "reset",
    "source_spec",
    "signal_scope",
    "property_intent",
    "antecedent",
    "consequent",
    "bounded_depth",
    "generated_by",
    "reviewer",
    "bind_status",
    "promotion_gate",
)
ALLOWED_REVIEW_STATUS = {"pending", "approved", "rejected", "needs_revision"}
ALLOWED_GENERATOR_SOURCE = {"human_seed", "llm_candidate", "retrieval_candidate", "tool_import"}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{label} must be a mapping")
        return {}
    return value


def require_non_empty_str(mapping: dict[str, Any], key: str, label: str, errors: list[str]) -> None:
    if not isinstance(mapping.get(key), str) or not mapping[key]:
        errors.append(f"{label}.{key} must be a non-empty string")


def validate_candidate(candidate: Any, path: Path, index: int, seen: set[str], errors: list[str]) -> None:
    label = f"{rel(path)} candidates[{index}]"
    if not isinstance(candidate, dict):
        errors.append(f"{label} must be a mapping")
        return
    for field in REQUIRED_CANDIDATE_FIELDS:
        if field not in candidate:
            errors.append(f"{label} missing required field {field}")
    for field in ("id", "status", "module", "clock", "property_intent", "antecedent", "consequent"):
        require_non_empty_str(candidate, field, label, errors)
    candidate_id = candidate.get("id")
    if isinstance(candidate_id, str):
        if candidate_id in seen:
            errors.append(f"{label}.id duplicate: {candidate_id}")
        seen.add(candidate_id)
    bounded_depth = candidate.get("bounded_depth")
    if not isinstance(bounded_depth, int) or bounded_depth <= 0:
        errors.append(f"{label}.bounded_depth must be a positive integer")
    for field in ("source_spec", "signal_scope", "promotion_gate"):
        value = candidate.get(field)
        if not isinstance(value, list) or not value:
            errors.append(f"{label}.{field} must be a non-empty list")
        elif not all(isinstance(item, str) and item for item in value):
            errors.append(f"{label}.{field} must contain only non-empty strings")
    reset = require_mapping(candidate.get("reset"), f"{label}.reset", errors)
    if reset:
        require_non_empty_str(reset, "signal", f"{label}.reset", errors)
        require_non_empty_str(reset, "active", f"{label}.reset", errors)
        require_non_empty_str(reset, "semantics", f"{label}.reset", errors)
    generated_by = require_mapping(candidate.get("generated_by"), f"{label}.generated_by", errors)
    if generated_by:
        if generated_by.get("source") not in ALLOWED_GENERATOR_SOURCE:
            errors.append(f"{label}.generated_by.source is invalid")
        require_non_empty_str(generated_by, "model_or_tool", f"{label}.generated_by", errors)
        if generated_by.get("source") != "human_seed" and not generated_by.get("prompt_log"):
            errors.append(f"{label}.generated_by.prompt_log is required for generated candidates")
    reviewer = require_mapping(candidate.get("reviewer"), f"{label}.reviewer", errors)
    if reviewer:
        if reviewer.get("required") is not True:
            errors.append(f"{label}.reviewer.required must be true")
        if reviewer.get("status") not in ALLOWED_REVIEW_STATUS:
            errors.append(f"{label}.reviewer.status is invalid")
    bind_status = require_mapping(candidate.get("bind_status"), f"{label}.bind_status", errors)
    if bind_status:
        if bind_status.get("bound_to_rtl") is not False:
            errors.append(f"{label}.bind_status.bound_to_rtl must be false")
        if bind_status.get("bind_file") is not None:
            errors.append(f"{label}.bind_status.bind_file must stay null until reviewed")
        quarantine_path = bind_status.get("quarantine_path")
        if not isinstance(quarantine_path, str) or not quarantine_path.startswith("build/ai_eda/assertion_candidates/"):
            errors.append(f"{label}.bind_status.quarantine_path must stay under build/ai_eda/assertion_candidates/")
    gates = candidate.get("promotion_gate")
    if isinstance(gates, list):
        for gate in ("make formal", "make cocotb-npu"):
            if gate not in gates:
                errors.append(f"{label}.promotion_gate missing {gate}")


def validate_manifest(path: Path) -> list[str]:
    errors: list[str] = []
    manifest = load_yaml(path)
    if manifest.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"{rel(path)} schema mismatch")
    if manifest.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append(f"{rel(path)} claim_boundary mismatch")
    if not isinstance(manifest.get("dut"), str) or not manifest["dut"]:
        errors.append(f"{rel(path)} dut must be non-empty")
    if not isinstance(manifest.get("source_ids"), list) or not manifest["source_ids"]:
        errors.append(f"{rel(path)} source_ids must be non-empty")
    policy = require_mapping(manifest.get("review_policy"), f"{rel(path)} review_policy", errors)
    if policy:
        for field in (
            "generated_assertions_committed_to_rtl",
            "generated_assertions_bound_to_rtl",
            "source_tree_write_allowed",
        ):
            if policy.get(field) is not False:
                errors.append(f"{rel(path)} review_policy.{field} must be false")
        for field in (
            "requires_signal_mapping_review",
            "requires_formal_or_simulation_pass",
            "requires_human_review",
        ):
            if policy.get(field) is not True:
                errors.append(f"{rel(path)} review_policy.{field} must be true")
    candidates = manifest.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        errors.append(f"{rel(path)} candidates must be non-empty")
        return errors
    seen: set[str] = set()
    for index, candidate in enumerate(candidates):
        validate_candidate(candidate, path, index, seen, errors)
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-dir", type=Path, default=DEFAULT_MANIFEST_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifests = sorted(args.manifest_dir.glob("*.yaml")) if args.manifest_dir.is_dir() else []
    if not manifests:
        print(f"STATUS: FAIL ai_eda.assertion_candidate_manifests no_manifests {rel(args.manifest_dir)}")
        return 1
    errors: list[str] = []
    candidate_count = 0
    for path in manifests:
        try:
            manifest = load_yaml(path)
            candidate_count += len(manifest.get("candidates", [])) if isinstance(manifest.get("candidates"), list) else 0
            errors.extend(validate_manifest(path))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel(path)} {exc}")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.assertion_candidate_manifests {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.assertion_candidate_manifests "
        f"manifests={len(manifests)} candidates={candidate_count} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
