#!/usr/bin/env python3
"""Validate tracked AI-EDA external asset manifests.

This check is intentionally metadata-only. It does not download, clone, import,
or execute external assets.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
SCHEMA_FILE = ROOT / "external/schemas/ai_eda_external_asset_manifest.v1.yaml"
CLAIM_BOUNDARY = "external_asset_registry_validation_only_no_download_or_release_claim"


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def validate_entry(entry: dict[str, Any], schema: dict[str, Any], seen: set[str]) -> list[str]:
    errors: list[str] = []
    entry_id = entry.get("id")
    if not isinstance(entry_id, str) or not entry_id:
        errors.append("entry is missing non-empty id")
    elif entry_id in seen:
        errors.append(f"{entry_id}: duplicate id")
    else:
        seen.add(entry_id)

    for field in schema["required_fields"]:
        if field not in entry:
            errors.append(f"{entry_id or '<unknown>'}: missing required field {field}")

    if entry.get("kind") not in schema["allowed_kind"]:
        errors.append(f"{entry_id}: invalid kind {entry.get('kind')!r}")
    if entry.get("priority") not in schema["allowed_priority"]:
        errors.append(f"{entry_id}: invalid priority {entry.get('priority')!r}")
    if entry.get("allowed_use") not in schema["allowed_use"]:
        errors.append(f"{entry_id}: invalid allowed_use {entry.get('allowed_use')!r}")

    source_url = entry.get("source_url")
    if not isinstance(source_url, str) or not source_url.startswith(("https://", "git@")):
        errors.append(f"{entry_id}: source_url must be an https or git URL")

    revision = entry.get("revision")
    if not isinstance(revision, dict) or not revision.get("type") or not revision.get("value"):
        errors.append(f"{entry_id}: revision must include type and value")

    fetch = entry.get("fetch")
    if not isinstance(fetch, dict):
        errors.append(f"{entry_id}: fetch must be a mapping")
    else:
        for field in schema["required_fetch_fields"]:
            if not fetch.get(field):
                errors.append(f"{entry_id}: fetch missing {field}")

    validation = entry.get("validation")
    if not isinstance(validation, dict):
        errors.append(f"{entry_id}: validation must be a mapping")
    else:
        for field in schema["required_validation_fields"]:
            if field not in validation:
                errors.append(f"{entry_id}: validation missing {field}")
        if validation.get("release_use_allowed") is not False:
            errors.append(f"{entry_id}: release_use_allowed must remain false")
        if validation.get("deterministic_replay_required") is not True:
            errors.append(f"{entry_id}: deterministic_replay_required must be true")

    lanes = as_list(entry.get("e1_lane"))
    if not lanes or not all(isinstance(lane, str) and lane for lane in lanes):
        errors.append(f"{entry_id}: e1_lane must name at least one lane")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lockfile", type=Path, default=LOCKFILE)
    parser.add_argument("--schema", type=Path, default=SCHEMA_FILE)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.lockfile.exists():
        print(f"STATUS: FAIL ai_eda.external_assets missing_lockfile {args.lockfile}")
        return 1
    if not args.schema.exists():
        print(f"STATUS: FAIL ai_eda.external_assets missing_schema {args.schema}")
        return 1

    lock = load_yaml(args.lockfile)
    schema = load_yaml(args.schema)
    errors: list[str] = []

    if lock.get("schema") != "eliza.ai_eda.external_sources_lock.v1":
        errors.append("lockfile schema must be eliza.ai_eda.external_sources_lock.v1")
    if lock.get("claim_boundary") != "external_asset_registry_only_no_download_training_inference_or_release_claim":
        errors.append("lockfile claim_boundary is missing or incorrect")

    policy = lock.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        if policy.get("large_payloads_committed") != "forbidden":
            errors.append("policy.large_payloads_committed must be forbidden")
        if policy.get("release_claims_from_predictions") != "forbidden":
            errors.append("policy.release_claims_from_predictions must be forbidden")
        if policy.get("deterministic_gate_required") is not True:
            errors.append("policy.deterministic_gate_required must be true")

    entries = lock.get("entries")
    if not isinstance(entries, list) or not entries:
        errors.append("entries must be a non-empty list")
    else:
        seen: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                errors.append("entry must be a mapping")
                continue
            errors.extend(validate_entry(entry, schema, seen))

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.external_assets {error}")
        return 1

    ids = [entry["id"] for entry in entries]
    print(
        "STATUS: PASS ai_eda.external_assets "
        f"entries={len(ids)} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
