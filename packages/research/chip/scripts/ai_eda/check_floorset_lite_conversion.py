#!/usr/bin/env python3
"""Validate normalized FloorSet Lite conversion records."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/floorset_lite/validation/conversion_report.json"
EXPECTED_SCHEMA = "eliza.ai_eda.floorset_lite_conversion_report.v1"
EXPECTED_CLAIM_BOUNDARY = "floorset_lite_conversion_training_only_no_e1_signoff_or_release_claim"
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "training_claim_allowed",
    "inference_claim_allowed",
    "e1_signoff_claim_allowed",
    "ppa_signoff_claim_allowed",
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


def validate_record(path: Path, schema: str) -> list[str]:
    record = load_json(path)
    errors: list[str] = []
    if record.get("schema") != schema:
        errors.append(f"{rel(path)}: schema mismatch")
    if record.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append(f"{rel(path)}: claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(record, rel(path)))
    if schema == "eda.graph_sample.v1":
        values = record.get("labels", {}).get("values", {})
        if not isinstance(values, dict) or "metrics" not in values:
            errors.append(f"{rel(path)}: graph labels must include metrics")
    if schema == "eda.flow_run.v1":
        metrics = record.get("metrics")
        if not isinstance(metrics, dict) or metrics.get("block_count", 0) < 21:
            errors.append(f"{rel(path)}: flow metrics must include block_count >= 21")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    errors.extend(validate_false_claim_flags(report, "report"))
    if report.get("converted_case_count") != 100:
        errors.append("converted_case_count must be 100")
    if report.get("converted_record_count") != 300:
        errors.append("converted_record_count must be 300")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be mapping")
    else:
        for field in ("contains_external_payload", "release_use_allowed", "e1_signoff_evidence"):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        for field in REQUIRED_FALSE_CLAIM_FLAGS:
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
        if policy.get("training_only") is not True:
            errors.append("policy.training_only must be true")
    records = report.get("converted_records")
    if not isinstance(records, list) or len(records) != 300:
        errors.append("converted_records must contain 300 entries")
        return errors
    schemas = {item.get("schema") for item in records if isinstance(item, dict)}
    if schemas != {"eda.design_bundle.v1", "eda.graph_sample.v1", "eda.flow_run.v1"}:
        errors.append("converted_records schema set mismatch")
    for index, item in enumerate(records):
        if not isinstance(item, dict):
            errors.append(f"converted_records[{index}] must be mapping")
            continue
        path_value = item.get("json")
        if not isinstance(path_value, str):
            errors.append(f"converted_records[{index}].json must be present")
            continue
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"converted record missing on disk: {path_value}")
            continue
        errors.extend(validate_record(path, str(item.get("schema"))))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.floorset_lite_conversion missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.floorset_lite_conversion {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.floorset_lite_conversion {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.floorset_lite_conversion "
        f"cases={report['converted_case_count']} records={report['converted_record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
