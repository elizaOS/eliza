#!/usr/bin/env python3
"""Validate the current AI-EDA research watchlist and optional capture report."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WATCHLIST = (
    ROOT
    / "research/alpha_chip_macro_placement/01_sources/ai_eda_current_research_watchlist_2026.yaml"
)
DEFAULT_INVENTORY = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml"
EXPECTED_SCHEMA = "eliza.ai_eda_current_research_watchlist.v1"
EXPECTED_REPORT_SCHEMA = "eliza.ai_eda.current_research_watchlist.v1"
EXPECTED_CLAIM_BOUNDARY = "current_research_watchlist_capture_only_no_import_training_inference_or_e1_claim"
EXPECTED_POLICY_FALSE = {
    "metadata_only": True,
    "imports_code": False,
    "downloads_assets": False,
    "calls_external_api": False,
    "runs_model": False,
    "generated_design_claim_allowed": False,
    "deterministic_e1_replay_required": True,
}
REQUIRED_ENTRY_FIELDS = {
    "id",
    "name",
    "year",
    "lane",
    "priority",
    "source_url",
    "public_code_status",
    "e1_action",
    "required_evidence",
}
ALLOWED_PRIORITIES = {"P0", "P1", "P2", "P3"}
ALLOWED_CODE_STATUS = {
    "available_to_review",
    "no_reference_implementation_selected",
    "paper_only",
}
FORBIDDEN_REPORT_POLICY_TRUE = {
    "changes_rtl",
    "changes_source",
    "changes_constraints",
    "changes_pd_config",
    "changes_layout",
    "changes_training_data",
    "generates_embeddings",
    "generates_layout",
    "runs_inference",
    "runs_llm",
    "runs_ml_model",
    "runs_synthesis",
    "runs_place_and_route",
    "runs_signoff",
    "trains_model",
    "finetunes_model",
    "downloads_external_assets",
    "downloads_model_weights",
    "calls_external_api",
    "imports_external_corpus",
    "prediction_generated",
    "release_use_allowed",
    "design_decision_claim_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def inventory_ids(path: Path) -> set[str]:
    inventory = load_yaml(path)
    entries = inventory.get("entries")
    if not isinstance(entries, list):
        raise ValueError(f"{rel(path)} entries must be a list")
    return {
        entry["id"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]
    }


def validate_watchlist(watchlist: dict[str, Any], inventory: set[str]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    ids: list[str] = []
    if watchlist.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"schema must be {EXPECTED_SCHEMA}")
    updated = watchlist.get("updated")
    updated_text = updated.isoformat() if isinstance(updated, date) else updated
    if not isinstance(updated_text, str) or not updated_text.startswith("2026-"):
        errors.append("updated must be a 2026 date string")
    policy = watchlist.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for key, expected in EXPECTED_POLICY_FALSE.items():
            if policy.get(key) is not expected:
                errors.append(f"policy.{key} must be {str(expected).lower()}")
    entries = watchlist.get("entries")
    if not isinstance(entries, list) or not entries:
        errors.append("entries must be a non-empty list")
        return errors, ids

    seen: set[str] = set()
    for index, entry in enumerate(entries):
        prefix = f"entries[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} must be a mapping")
            continue
        missing = sorted(REQUIRED_ENTRY_FIELDS - set(entry))
        if missing:
            errors.append(f"{prefix} missing required fields: {', '.join(missing)}")
            continue
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            errors.append(f"{prefix}.id must be non-empty")
            continue
        if entry_id in seen:
            errors.append(f"duplicate id {entry_id}")
        seen.add(entry_id)
        ids.append(entry_id)
        if entry_id not in inventory:
            errors.append(f"{entry_id}: missing from ai_eda_source_inventory.yaml")
        if not isinstance(entry.get("name"), str) or not entry["name"]:
            errors.append(f"{entry_id}: name must be non-empty")
        if not isinstance(entry.get("year"), int) or entry["year"] < 2025:
            errors.append(f"{entry_id}: year must be an integer >= 2025")
        if not isinstance(entry.get("lane"), str) or not entry["lane"]:
            errors.append(f"{entry_id}: lane must be non-empty")
        if entry.get("priority") not in ALLOWED_PRIORITIES:
            errors.append(f"{entry_id}: priority must be one of {sorted(ALLOWED_PRIORITIES)}")
        source_url = entry.get("source_url")
        if not isinstance(source_url, str) or not source_url.startswith("https://"):
            errors.append(f"{entry_id}: source_url must be https")
        if entry.get("public_code_status") not in ALLOWED_CODE_STATUS:
            errors.append(f"{entry_id}: public_code_status must be reviewed enum")
        for field in ("e1_action", "required_evidence"):
            value = entry.get(field)
            if not isinstance(value, str) or len(value.strip()) < 40:
                errors.append(f"{entry_id}: {field} must be a specific non-empty paragraph")
        evidence = str(entry.get("required_evidence", "")).lower()
        if "hash" not in evidence or ("replay" not in evidence and "signoff" not in evidence):
            errors.append(f"{entry_id}: required_evidence must mention hashes and replay/signoff")
    return errors, ids


def validate_report(report: dict[str, Any], report_path: Path, watchlist_path: Path, ids: list[str]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_REPORT_SCHEMA:
        errors.append("report schema mismatch")
    if report.get("mode") != "dry-run":
        errors.append("report mode must be dry-run")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    if report.get("status") != "TARGET_CAPTURE_ONLY_CURRENT_RESEARCH_NO_IMPORT":
        errors.append("report status mismatch")
    source_ids = report.get("source_ids")
    if source_ids != ids:
        errors.append("report source_ids must match watchlist order exactly")
    if report.get("missing_inventory_ids") not in ([], None):
        errors.append("report missing_inventory_ids must be empty")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("report policy must be a mapping")
    else:
        for key in FORBIDDEN_REPORT_POLICY_TRUE:
            if policy.get(key) is not False:
                errors.append(f"report policy.{key} must be false")
    artifacts = report.get("input_artifacts")
    if not isinstance(artifacts, list):
        errors.append("report input_artifacts must be a list")
    else:
        watchlist_rel = rel(watchlist_path)
        expected_hash = sha256_file(watchlist_path)
        matching = [
            artifact
            for artifact in artifacts
            if isinstance(artifact, dict) and artifact.get("path") == watchlist_rel
        ]
        if not matching:
            errors.append("report input_artifacts missing watchlist artifact")
        elif matching[0].get("sha256") != expected_hash:
            errors.append("report watchlist artifact hash is stale")
    tasks = report.get("candidate_tasks")
    if not isinstance(tasks, list) or len(tasks) != len(ids):
        errors.append("report candidate_tasks count must match watchlist")
    elif [task.get("id", "").removesuffix("-intake") for task in tasks if isinstance(task, dict)] != ids:
        errors.append("report candidate_tasks must match watchlist order")
    if not report_path.is_file():
        errors.append(f"report disappeared during validation: {rel(report_path)}")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    try:
        inventory = inventory_ids(args.inventory)
        watchlist = load_yaml(args.watchlist)
        watchlist_errors, ids = validate_watchlist(watchlist, inventory)
        errors.extend(watchlist_errors)
        if args.report:
            report = load_json(args.report)
            errors.extend(validate_report(report, args.report, args.watchlist, ids))
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.current_research_watchlist_check {error}")
        return 1
    suffix = f" report={rel(args.report)}" if args.report else ""
    print(
        "STATUS: PASS ai_eda.current_research_watchlist_check "
        f"entries={len(ids)} watchlist={rel(args.watchlist)}{suffix}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
