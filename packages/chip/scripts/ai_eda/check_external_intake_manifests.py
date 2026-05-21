#!/usr/bin/env python3
"""Validate tracked per-asset external intake manifests.

This is a metadata-only gate. It validates license/provenance intake records
that are safe to commit, while keeping fetched datasets, repositories, and
model weights under ignored payload paths.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
SCHEMA_FILE = ROOT / "external/schemas/ai_eda_external_intake_manifest.v1.yaml"
DEFAULT_REPORT_ROOT = ROOT / "build/ai_eda/external_intake"
CLAIM_BOUNDARY = "external_intake_manifest_validation_only_no_payload_no_training_no_release_claim"


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected YAML mapping")
    return data


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def lock_entries(lock: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries = lock.get("entries")
    if not isinstance(entries, list):
        raise ValueError("external/SOURCES.lock.yaml entries must be a list")
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            result[entry["id"]] = entry
    return result


def manifest_paths(root: Path) -> list[Path]:
    paths: list[Path] = []
    for bucket in ("repos", "datasets", "models"):
        paths.extend(sorted((root / "external" / bucket).glob("*/manifest.yaml")))
    return paths


def validate_manifest(
    path: Path,
    manifest: dict[str, Any],
    schema: dict[str, Any],
    entries: dict[str, dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    errors: list[str] = []
    asset_id = manifest.get("asset_id")
    for field in schema["required_fields"]:
        if field not in manifest:
            errors.append(f"{rel(path)}: missing required field {field}")
    if manifest.get("schema") != "eliza.ai_eda.external_intake_manifest.v1":
        errors.append(f"{rel(path)}: invalid schema {manifest.get('schema')!r}")
    if not isinstance(asset_id, str) or asset_id not in entries:
        errors.append(f"{rel(path)}: asset_id is not present in SOURCES.lock.yaml")
        lock_entry: dict[str, Any] = {}
    else:
        lock_entry = entries[asset_id]
        if manifest.get("kind") != lock_entry.get("kind"):
            errors.append(f"{asset_id}: kind does not match lockfile")
        if manifest.get("source_url") != lock_entry.get("source_url"):
            errors.append(f"{asset_id}: source_url does not match lockfile")

    if manifest.get("kind") not in schema["allowed_kind"]:
        errors.append(f"{asset_id}: invalid kind {manifest.get('kind')!r}")

    revision = manifest.get("upstream_revision")
    if not isinstance(revision, dict):
        errors.append(f"{asset_id}: upstream_revision must be a mapping")
    else:
        for field in schema["required_revision_fields"]:
            if not revision.get(field):
                errors.append(f"{asset_id}: upstream_revision missing {field}")
        lock_revision = lock_entry.get("revision") if lock_entry else None
        if isinstance(lock_revision, dict):
            if revision.get("type") != lock_revision.get("type"):
                errors.append(f"{asset_id}: revision type does not match lockfile")
            if lock_revision.get("value") not in (revision.get("value"), "PIN_AFTER_FETCH"):
                errors.append(f"{asset_id}: revision value does not match lockfile")

    license_info = manifest.get("license")
    if not isinstance(license_info, dict):
        errors.append(f"{asset_id}: license must be a mapping")
    else:
        for field in schema["required_license_fields"]:
            if field not in license_info:
                errors.append(f"{asset_id}: license missing {field}")
        evidence = license_info.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"{asset_id}: license.evidence must be a non-empty list")

    intake = manifest.get("intake")
    if not isinstance(intake, dict):
        errors.append(f"{asset_id}: intake must be a mapping")
    else:
        for field in schema["required_intake_fields"]:
            if field not in intake:
                errors.append(f"{asset_id}: intake missing {field}")
        if intake.get("review_status") not in schema["allowed_review_status"]:
            errors.append(f"{asset_id}: invalid intake.review_status")
        if lock_entry and intake.get("allowed_use") != lock_entry.get("allowed_use"):
            errors.append(f"{asset_id}: intake.allowed_use does not match lockfile")
        if intake.get("release_use_allowed") is not False:
            errors.append(f"{asset_id}: release_use_allowed must be false")
        if intake.get("deterministic_replay_required") is not True:
            errors.append(f"{asset_id}: deterministic_replay_required must be true")

    local_payload = manifest.get("local_payload")
    if not isinstance(local_payload, dict):
        errors.append(f"{asset_id}: local_payload must be a mapping")
    else:
        for field in schema["required_local_payload_fields"]:
            if field not in local_payload:
                errors.append(f"{asset_id}: local_payload missing {field}")
        payload_path = local_payload.get("payload_path")
        if isinstance(payload_path, str) and not payload_path.endswith("/payload"):
            errors.append(f"{asset_id}: payload_path must end in /payload")
        if local_payload.get("downloaded") is True and local_payload.get("checksum_status") == "blocked_until_fetch":
            errors.append(f"{asset_id}: downloaded payload must not have blocked checksum status")

    if manifest.get("claim_boundary") != "external_intake_metadata_only_no_payload_no_training_no_release_claim":
        errors.append(f"{asset_id}: invalid claim_boundary")

    extra_files = [
        child.name
        for child in path.parent.iterdir()
        if child.name != "manifest.yaml" and child.name != "payload"
    ]
    if extra_files:
        errors.append(f"{asset_id}: tracked metadata directory contains unexpected files: {extra_files}")

    return errors, {
        "asset_id": asset_id,
        "path": rel(path),
        "kind": manifest.get("kind"),
        "review_status": intake.get("review_status") if isinstance(intake, dict) else None,
        "downloaded": local_payload.get("downloaded") if isinstance(local_payload, dict) else None,
        "payload_path": local_payload.get("payload_path") if isinstance(local_payload, dict) else None,
        "release_use_allowed": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lockfile", type=Path, default=LOCKFILE)
    parser.add_argument("--schema", type=Path, default=SCHEMA_FILE)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--report-root", type=Path, default=DEFAULT_REPORT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    lock = load_yaml(args.lockfile)
    schema = load_yaml(args.schema)
    entries = lock_entries(lock)
    errors: list[str] = []
    manifests: list[dict[str, Any]] = []
    for path in manifest_paths(ROOT):
        manifest = load_yaml(path)
        manifest_errors, summary = validate_manifest(path, manifest, schema, entries)
        errors.extend(manifest_errors)
        manifests.append(summary)

    report = {
        "schema": "eliza.ai_eda.external_intake_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "manifest_count": len(manifests),
        "manifests": manifests,
        "policy": {
            "contains_external_payloads": False,
            "release_use_allowed": False,
            "metadata_manifest_does_not_prove_training_ready": True,
        },
        "errors": errors,
    }
    out_dir = args.report_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "external_intake_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.external_intake {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.external_intake "
        f"manifests={len(manifests)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
