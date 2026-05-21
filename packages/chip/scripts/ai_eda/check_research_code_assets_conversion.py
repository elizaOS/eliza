#!/usr/bin/env python3
"""Validate normalized AI-EDA research-code asset records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/research_code_assets/validation/conversion_report.json"
CLAIM_BOUNDARY = (
    "ai_eda_research_code_asset_text_sample_only_no_training_inference_or_release_claim"
)
REQUIRED_ASSETS = {
    "chipdiffusion",
    "chipformer",
    "core-placement",
    "maptune",
    "abc-rl",
    "abcrl",
    "rl4ls",
    "mcp4eda",
    "orfs-agent",
    "openroad-agent",
    "openroad-mcp",
    "open3dbench",
    "dreamplace",
}
REQUIRED_TASKS = {"ai_eda_research_asset_summary", "ai_eda_research_asset_inventory"}


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
        raise ValueError(f"{path}: expected JSON object")
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
    if record.get("asset_id") not in REQUIRED_ASSETS:
        errors.append(f"{record_id}: unexpected asset_id {record.get('asset_id')!r}")
    if record.get("task_type") not in REQUIRED_TASKS:
        errors.append(f"{record_id}: unexpected task_type {record.get('task_type')!r}")
    if record.get("split") != "train":
        errors.append(f"{record_id}: split must be train")
    prompt = record.get("prompt")
    if not isinstance(prompt, str) or len(prompt) < 20:
        errors.append(f"{record_id}: prompt must be substantive")
    response = record.get("response")
    if not isinstance(response, dict):
        errors.append(f"{record_id}: response must be a mapping")
    else:
        content = response.get("content")
        if not isinstance(response.get("kind"), str) or not response["kind"].startswith(
            "structured_research_asset_"
        ):
            errors.append(f"{record_id}: response.kind mismatch")
        if not isinstance(content, dict):
            errors.append(f"{record_id}: response.content must be structured metadata")
        elif content.get("asset_id") != record.get("asset_id"):
            errors.append(f"{record_id}: response.content.asset_id mismatch")
    provenance = record.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("generated_by")
        != "scripts/ai_eda/convert_research_code_assets_to_internal_records.py"
    ):
        errors.append(f"{record_id}: provenance.generated_by mismatch")
    replay = record.get("replay")
    if not isinstance(
        replay, dict
    ) or "convert_research_code_assets_to_internal_records.py" not in str(
        replay.get("deterministic_command")
    ):
        errors.append(f"{record_id}: replay command mismatch")
    errors.extend(validate_source(record, record_id))
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.research_code_assets_conversion_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    if set(report.get("asset_ids", [])) != REQUIRED_ASSETS:
        errors.append("report asset_ids must match required research-code assets")
    if report.get("blocked_assets") != []:
        errors.append("blocked_assets must be empty for local validation")
    if report.get("converted_asset_count") != len(REQUIRED_ASSETS):
        errors.append("converted_asset_count mismatch")
    if report.get("converted_record_count") != len(REQUIRED_ASSETS) * len(REQUIRED_TASKS):
        errors.append("converted_record_count mismatch")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "contains_model_weights",
            "executes_research_code",
            "trains_model",
            "runs_inference",
            "release_use_allowed",
            "e1_signoff_evidence",
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        if policy.get("deterministic_replay_required_for_optimization_claims") is not True:
            errors.append(
                "policy.deterministic_replay_required_for_optimization_claims must be true"
            )
    converted = report.get("converted_records")
    if not isinstance(converted, list):
        return errors + ["converted_records must be a list"]
    record_paths: list[Path] = []
    seen: dict[str, set[str]] = {}
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entries must be mappings")
            continue
        asset_id = item.get("asset_id")
        task_type = item.get("task_type")
        if isinstance(asset_id, str) and isinstance(task_type, str):
            seen.setdefault(asset_id, set()).add(task_type)
        path_value = item.get("json")
        if isinstance(path_value, str):
            record_paths.append(repo_path(path_value))
        else:
            errors.append("converted record missing json path")
    actual_records = sorted((report_path.parent / "records").glob("*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")
    for asset_id in sorted(REQUIRED_ASSETS):
        if seen.get(asset_id) != REQUIRED_TASKS:
            errors.append(f"{asset_id}: expected summary and inventory records")
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
            f"STATUS: FAIL ai_eda.research_code_assets_conversion missing_report {rel(report_path)}"
        )
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.research_code_assets_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.research_code_assets_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.research_code_assets_conversion "
        f"assets={report['converted_asset_count']} records={report['converted_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
