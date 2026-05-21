#!/usr/bin/env python3
"""Validate normalized current-research watchlist text instruction records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/current_research_watchlist_records/validation/conversion_report.json"
)
CLAIM_BOUNDARY = (
    "current_research_watchlist_text_sample_only_no_import_training_inference_e1_or_release_claim"
)
REQUIRED_TASK_TYPE = "ai_eda_current_research_watchlist_intake"
REQUIRED_KIND = "structured_current_research_watchlist_intake"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_source(record: dict[str, Any], record_id: str) -> list[str]:
    errors: list[str] = []
    source = record.get("source")
    if not isinstance(source, dict):
        return [f"{record_id}: source must be a mapping"]
    path_value = source.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{record_id}: source.path must be present")
    elif not repo_path(path_value).is_file():
        errors.append(f"{record_id}: source.path missing on disk: {path_value}")
    sha = source.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        errors.append(f"{record_id}: source.sha256 must be a 64-character digest")
    if not isinstance(source.get("row_index"), int):
        errors.append(f"{record_id}: source.row_index must be an integer")
    return errors


def validate_record(path: Path) -> list[str]:
    record = load_json(path)
    record_id = str(record.get("id", rel(path)))
    errors: list[str] = []
    if record.get("schema") != "eda.text_instruction_sample.v1":
        errors.append(f"{record_id}: schema mismatch")
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: claim_boundary mismatch")
    if record.get("task_type") != REQUIRED_TASK_TYPE:
        errors.append(f"{record_id}: task_type mismatch")
    if record.get("split") != "train":
        errors.append(f"{record_id}: split must be train")
    prompt = record.get("prompt")
    if not isinstance(prompt, str) or len(prompt) < 40:
        errors.append(f"{record_id}: prompt must be substantive")
    response = record.get("response")
    if not isinstance(response, dict):
        errors.append(f"{record_id}: response must be a mapping")
    else:
        if response.get("kind") != REQUIRED_KIND:
            errors.append(f"{record_id}: response.kind mismatch")
        content = response.get("content")
        if not isinstance(content, dict):
            errors.append(f"{record_id}: response.content must be structured metadata")
        else:
            if content.get("id") != record.get("asset_id"):
                errors.append(f"{record_id}: response.content.id must match asset_id")
            for field in (
                "name",
                "lane",
                "priority",
                "source_url",
                "public_code_status",
                "e1_action",
                "required_evidence",
            ):
                if not isinstance(content.get(field), str) or not content[field]:
                    errors.append(f"{record_id}: response.content.{field} must be non-empty")
            evidence = str(content.get("required_evidence", "")).lower()
            if "hash" not in evidence or ("replay" not in evidence and "signoff" not in evidence):
                errors.append(
                    f"{record_id}: required_evidence must mention hashes and replay/signoff"
                )
            blocked_by = content.get("blocked_by")
            if not isinstance(blocked_by, list) or len(blocked_by) < 3:
                errors.append(f"{record_id}: blocked_by must list intake blockers")
    provenance = record.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("generated_by")
        != "scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py"
    ):
        errors.append(f"{record_id}: provenance.generated_by mismatch")
    replay = record.get("replay")
    if not isinstance(
        replay, dict
    ) or "convert_current_research_watchlist_to_internal_records.py" not in str(
        replay.get("deterministic_command")
    ):
        errors.append(f"{record_id}: replay command mismatch")
    errors.extend(validate_source(record, record_id))
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.current_research_watchlist_records_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "imports_code",
            "downloads_assets",
            "executes_research_code",
            "runs_model",
            "trains_model",
            "runs_inference",
            "release_use_allowed",
            "e1_signoff_evidence",
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in ("metadata_only", "deterministic_replay_required_for_optimization_claims"):
            if policy.get(field) is not True:
                errors.append(f"policy.{field} must be true")
    converted = report.get("converted_records")
    if not isinstance(converted, list) or not converted:
        return errors + ["converted_records must be a non-empty list"]
    if report.get("converted_record_count") != len(converted):
        errors.append("converted_record_count mismatch")
    record_paths: list[Path] = []
    seen_ids: set[str] = set()
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entries must be mappings")
            continue
        record_id = item.get("id")
        if not isinstance(record_id, str) or not record_id:
            errors.append("converted record missing id")
        elif record_id in seen_ids:
            errors.append(f"duplicate record id {record_id}")
        else:
            seen_ids.add(record_id)
        if item.get("schema") != "eda.text_instruction_sample.v1":
            errors.append(f"{record_id}: report schema mismatch")
        if item.get("task_type") != REQUIRED_TASK_TYPE:
            errors.append(f"{record_id}: report task_type mismatch")
        path_value = item.get("json")
        if isinstance(path_value, str):
            record_paths.append(repo_path(path_value))
        else:
            errors.append(f"{record_id}: missing json path")
    actual_records = sorted((report_path.parent / "records").glob("*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")
    for path in record_paths:
        if not path.is_file():
            errors.append(f"missing record {rel(path)}")
            continue
        errors.extend(validate_record(path))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(
            f"STATUS: FAIL ai_eda.current_research_watchlist_records missing_report {rel(report_path)}"
        )
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.current_research_watchlist_records {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.current_research_watchlist_records {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.current_research_watchlist_records "
        f"records={report['converted_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
