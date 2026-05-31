#!/usr/bin/env python3
"""Validate normalized VeriReason RTL-Coder records and conversion report."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/verireason_rtl_coder/validation/conversion_report.json"
CLAIM_BOUNDARY = "verireason_rtl_coder_text_sample_only_no_training_inference_e1_or_release_claim"
EXPECTED_ASSETS = {
    "verireason-rtl-coder-small",
    "verireason-rtl-coder-reasoning-simple",
    "verireason-rtl-coder-reasoning-hard",
    "verireason-rtl-coder-reasoning-combined",
}
EXPECTED_RECORD_COUNT = 6433
REQUIRED_TASK_TYPE = "verireason_rtl_generation_with_testbench_feedback"
REQUIRED_KIND = "structured_verireason_rtl_coder_sample"
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_signoff_claim_allowed",
    "rtl_generation_claim_allowed",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_false_claim_flags(record: dict[str, Any], label: str) -> list[str]:
    return [
        f"{label}: {field} must be false"
        for field in REQUIRED_FALSE_CLAIM_FLAGS
        if record.get(field) is not False
    ]


def validate_record(path: Path, item: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    record = load_json(path)
    record_id = str(record.get("id", rel(path)))
    if record.get("schema") != "eda.text_instruction_sample.v1":
        errors.append(f"{record_id}: schema mismatch")
    for field in ("id", "asset_id", "source", "split", "task_type", "prompt", "response"):
        if field not in record:
            errors.append(f"{record_id}: missing {field}")
    if record.get("id") != item.get("id"):
        errors.append(f"{record_id}: report id mismatch")
    if record.get("asset_id") != item.get("asset_id"):
        errors.append(f"{record_id}: report asset_id mismatch")
    if record.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"{record_id}: claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(record, record_id))
    if record.get("task_type") != REQUIRED_TASK_TYPE:
        errors.append(f"{record_id}: task_type mismatch")
    if record.get("split") not in {"train", "val", "test"}:
        errors.append(f"{record_id}: split must be train, val, or test")
    prompt = record.get("prompt")
    if not isinstance(prompt, str) or len(prompt.strip()) < 8:
        errors.append(f"{record_id}: prompt must be non-empty")
    response = record.get("response")
    if not isinstance(response, dict):
        errors.append(f"{record_id}: response must be a mapping")
    else:
        if response.get("kind") != REQUIRED_KIND:
            errors.append(f"{record_id}: response.kind mismatch")
        content = response.get("content")
        if not isinstance(content, dict):
            errors.append(f"{record_id}: response.content must be a mapping")
        else:
            if not isinstance(content.get("output"), str) or not content["output"].strip():
                errors.append(f"{record_id}: response.content.output must be non-empty")
            for flag in (
                "generated_rtl_quarantined_until_review",
                "requires_license_schema_and_contamination_review",
                "deterministic_simulation_or_formal_replay_required",
                "no_release_or_e1_optimization_claim_from_text_record",
            ):
                policy = content.get("policy")
                if not isinstance(policy, dict) or policy.get(flag) is not True:
                    errors.append(f"{record_id}: response.content.policy.{flag} must be true")
    source = record.get("source")
    if not isinstance(source, dict):
        errors.append(f"{record_id}: source must be a mapping")
    else:
        source_path_value = source.get("path")
        if source_path_value != item.get("source_file"):
            errors.append(f"{record_id}: report source_file mismatch")
        if not isinstance(source_path_value, str) or not repo_path(source_path_value).is_file():
            errors.append(f"{record_id}: source.path missing")
        else:
            source_path = repo_path(source_path_value)
            if source.get("sha256") != sha256_file(source_path):
                errors.append(f"{record_id}: stale source sha256")
        if source.get("row_index") != item.get("source_row_index"):
            errors.append(f"{record_id}: source row mismatch")
    provenance = record.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("generated_by")
        != "scripts/ai_eda/convert_verireason_rtl_coder_to_internal_records.py"
    ):
        errors.append(f"{record_id}: provenance.generated_by mismatch")
    replay = record.get("replay")
    if not isinstance(replay, dict) or "convert_verireason_rtl_coder" not in str(
        replay.get("deterministic_command")
    ):
        errors.append(f"{record_id}: replay deterministic command mismatch")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.verireason_rtl_coder_conversion_report.v1":
        errors.append("report schema mismatch")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append("report claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(report, "report"))
    if report.get("blocked_assets") != []:
        errors.append("blocked_assets must be empty")
    if report.get("converted_asset_count") != len(EXPECTED_ASSETS):
        errors.append("converted_asset_count mismatch")
    if report.get("converted_record_count") != EXPECTED_RECORD_COUNT:
        errors.append("converted_record_count mismatch")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "contains_model_weights",
            "runs_training",
            "runs_inference",
            "release_use_allowed",
            "e1_signoff_evidence",
            *REQUIRED_FALSE_CLAIM_FLAGS,
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in (
            "metadata_and_text_normalization_only",
            "generated_rtl_quarantined_until_review",
            "deterministic_replay_required_for_optimization_claims",
        ):
            if policy.get(field) is not True:
                errors.append(f"policy.{field} must be true")
    assets = report.get("assets")
    if not isinstance(assets, list):
        return errors + ["assets must be a list"]
    asset_ids = {asset.get("id") for asset in assets if isinstance(asset, dict)}
    if asset_ids != EXPECTED_ASSETS:
        errors.append("assets must match expected VeriReason dataset set")
    file_record_total = 0
    for asset in assets:
        if not isinstance(asset, dict):
            errors.append("asset entries must be mappings")
            continue
        files = asset.get("files")
        if not isinstance(files, list) or not files:
            errors.append(f"{asset.get('id')}: files must be non-empty")
            continue
        asset_file_total = 0
        for file_item in files:
            if not isinstance(file_item, dict):
                errors.append(f"{asset.get('id')}: file entry must be a mapping")
                continue
            path_value = file_item.get("path")
            if not isinstance(path_value, str) or not repo_path(path_value).is_file():
                errors.append(f"{asset.get('id')}: source file missing {path_value}")
                continue
            path = repo_path(path_value)
            if file_item.get("sha256") != sha256_file(path):
                errors.append(f"{asset.get('id')}: stale source sha256 for {path_value}")
            if file_item.get("line_count") != file_item.get("record_count"):
                errors.append(f"{asset.get('id')}: line_count and record_count must match")
            asset_file_total += int(file_item.get("record_count", 0))
        if asset.get("record_count") != asset_file_total:
            errors.append(f"{asset.get('id')}: asset record_count mismatch")
        file_record_total += asset_file_total
    converted = report.get("converted_records")
    if not isinstance(converted, list):
        return errors + ["converted_records must be a list"]
    if len(converted) != report.get("converted_record_count"):
        errors.append("converted_records length mismatch")
    if file_record_total != len(converted):
        errors.append("asset file totals must match converted_records")
    record_paths: list[Path] = []
    seen_ids: set[str] = set()
    split_counts: Counter[str] = Counter()
    tb_count = 0
    tb_result_count = 0
    for item in converted:
        if not isinstance(item, dict):
            errors.append("converted_records entry must be a mapping")
            continue
        record_id = item.get("id")
        if not isinstance(record_id, str) or not record_id:
            errors.append("converted record id must be non-empty")
        elif record_id in seen_ids:
            errors.append(f"duplicate record id {record_id}")
        else:
            seen_ids.add(record_id)
        path_value = item.get("json")
        if not isinstance(path_value, str):
            errors.append(f"{record_id}: missing json path")
            continue
        path = repo_path(path_value)
        record_paths.append(path)
        if path.is_file():
            record = load_json(path)
            content = record.get("response", {}).get("content", {})
            if isinstance(content, dict) and "testbench" in content:
                tb_count += 1
            if isinstance(content, dict) and "testbench_result" in content:
                tb_result_count += 1
        if item.get("split") in {"train", "val", "test"}:
            split_counts[str(item["split"])] += 1
    actual_records = sorted((report_path.parent / "records").glob("*.json"))
    if sorted(record_paths) != actual_records:
        errors.append("report converted paths must exactly match records directory")
    for split in ("train", "val", "test"):
        if split_counts[split] <= 0:
            errors.append(f"split_counts.{split} must be positive")
    if report.get("split_counts") != dict(sorted(split_counts.items())):
        errors.append("split_counts mismatch")
    if report.get("testbench_record_count") != tb_count:
        errors.append("testbench_record_count mismatch")
    if report.get("testbench_result_record_count") != tb_result_count:
        errors.append("testbench_result_record_count mismatch")
    if tb_count != 3784 or tb_result_count != 3784:
        errors.append("expected 3784 testbench/testbench_result records")
    for path, item in zip(record_paths, converted, strict=False):
        if not path.is_file():
            errors.append(f"missing record {rel(path)}")
            continue
        errors.extend(validate_record(path, item))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.verireason_rtl_coder missing_report {rel(report_path)}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate_report(report, report_path)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.verireason_rtl_coder {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.verireason_rtl_coder {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.verireason_rtl_coder "
        f"assets={report['converted_asset_count']} records={report['converted_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
