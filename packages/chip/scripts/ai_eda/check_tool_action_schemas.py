#!/usr/bin/env python3
"""Validate AI-EDA typed tool-action schemas and examples."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_FILE = ROOT / "docs/spec-db/ai-eda/tool-action-schemas.yaml"
EXAMPLES_DIR = ROOT / "docs/spec-db/ai-eda/tool-action-examples"
CLAIM_BOUNDARY = "tool_action_schema_validation_only_no_tool_execution_or_release_claim"


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def validate_nested(
    record_id: str, document: dict[str, Any], nested: dict[str, list[str]]
) -> list[str]:
    errors: list[str] = []
    for parent, fields in nested.items():
        value = document.get(parent)
        if not isinstance(value, dict):
            errors.append(f"{record_id}: {parent} must be a mapping")
            continue
        for field in fields:
            if field not in value:
                errors.append(f"{record_id}: missing {parent}.{field}")
    return errors


def validate_example(path: Path, schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    document = load_yaml(path)
    if not isinstance(document, dict):
        return [f"{path}: example must be a mapping"]
    record_id = str(document.get("id", path))
    if document.get("schema") != "eda.tool_action.v1":
        errors.append(f"{record_id}: schema must be eda.tool_action.v1")
    for field in schema["required_fields"]:
        if field not in document:
            errors.append(f"{record_id}: missing required field {field}")
    errors.extend(validate_nested(record_id, document, schema["required_nested"]))

    action_type = document.get("action_type")
    mode = document.get("mode")
    decision_value = document.get("decision")
    decision: dict[str, Any] = decision_value if isinstance(decision_value, dict) else {}
    safety_value = document.get("safety")
    safety: dict[str, Any] = safety_value if isinstance(safety_value, dict) else {}
    command_value = document.get("command")
    command: dict[str, Any] = command_value if isinstance(command_value, dict) else {}
    scope_value = document.get("scope")
    scope: dict[str, Any] = scope_value if isinstance(scope_value, dict) else {}

    if action_type in schema["forbidden_action_types"] and mode != "blocked":
        errors.append(f"{record_id}: forbidden action_type {action_type} must use mode blocked")
    if (
        action_type not in schema["allowed_action_types"]
        and action_type not in schema["forbidden_action_types"]
    ):
        errors.append(f"{record_id}: unknown action_type {action_type!r}")
    if mode not in schema["allowed_modes"]:
        errors.append(f"{record_id}: invalid mode {mode!r}")
    if decision.get("status") not in schema["allowed_decision_status"]:
        errors.append(f"{record_id}: invalid decision.status {decision.get('status')!r}")

    if safety.get("source_tree_write_allowed") is not False:
        errors.append(f"{record_id}: source_tree_write_allowed must be false")
    if safety.get("release_use_allowed") is not False:
        errors.append(f"{record_id}: release_use_allowed must be false")
    if safety.get("deterministic_replay_required") is not True:
        errors.append(f"{record_id}: deterministic_replay_required must be true")
    if safety.get("human_review_required") is not True:
        errors.append(f"{record_id}: human_review_required must be true")

    write_paths = scope.get("write_paths", [])
    if not isinstance(write_paths, list):
        errors.append(f"{record_id}: scope.write_paths must be a list")
    elif mode != "blocked" and any(
        isinstance(path, str) and not path.startswith("build/ai_eda/") for path in write_paths
    ):
        errors.append(f"{record_id}: non-blocked write paths must stay under build/ai_eda/")

    forbidden_paths = scope.get("forbidden_paths", [])
    if not isinstance(forbidden_paths, list) or not forbidden_paths:
        errors.append(f"{record_id}: scope.forbidden_paths must be non-empty")

    tool = command.get("tool")
    allowlist = schema.get("tool_allowlist", {})
    if mode != "blocked" and tool not in allowlist:
        errors.append(f"{record_id}: command.tool {tool!r} is not in tool_allowlist")
    if mode != "blocked" and isinstance(tool, str):
        allowed_modes = allowlist.get(tool, {}).get("allowed_modes", [])
        if mode not in allowed_modes:
            errors.append(f"{record_id}: mode {mode!r} not allowed for tool {tool!r}")

    claim_boundary = document.get("claim_boundary")
    if not isinstance(claim_boundary, str) or "release_claim" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must explicitly forbid release claims")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema-file", type=Path, default=SCHEMA_FILE)
    parser.add_argument("--examples-dir", type=Path, default=EXAMPLES_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    if not args.schema_file.exists():
        print(f"STATUS: FAIL ai_eda.tool_action_schema missing_schema {args.schema_file}")
        return 1
    schema = load_yaml(args.schema_file)
    if not isinstance(schema, dict):
        print(f"STATUS: FAIL ai_eda.tool_action_schema invalid_schema {args.schema_file}")
        return 1
    if schema.get("schema") != "eliza.ai_eda.tool_action_schemas.v1":
        errors.append("schema id must be eliza.ai_eda.tool_action_schemas.v1")
    if (
        schema.get("claim_boundary")
        != "tool_action_schema_only_no_tool_execution_design_change_or_release_claim"
    ):
        errors.append("top-level claim_boundary is missing or incorrect")
    policy = schema.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        if policy.get("default_mode") != "dry_run":
            errors.append("policy.default_mode must be dry_run")
        if policy.get("write_capable_actions_enabled") is not False:
            errors.append("policy.write_capable_actions_enabled must be false")
        if policy.get("source_tree_write_forbidden") is not True:
            errors.append("policy.source_tree_write_forbidden must be true")
        if policy.get("release_use_allowed") is not False:
            errors.append("policy.release_use_allowed must be false")
    for field in (
        "allowed_action_types",
        "forbidden_action_types",
        "required_fields",
        "required_nested",
        "tool_allowlist",
    ):
        if field not in schema:
            errors.append(f"schema missing {field}")
    examples = sorted(args.examples_dir.glob("*.yaml")) if args.examples_dir.exists() else []
    if not examples:
        errors.append(f"no tool-action examples found in {args.examples_dir}")
    for path in examples:
        errors.extend(validate_example(path, schema))

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.tool_action_schema {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.tool_action_schemas "
        f"examples={len(examples)} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
