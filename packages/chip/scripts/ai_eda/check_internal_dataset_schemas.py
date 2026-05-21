#!/usr/bin/env python3
"""Validate internal AI-EDA dataset schemas and example fixtures."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_FILE = ROOT / "docs/spec-db/ai-eda/internal-dataset-schemas.yaml"
EXAMPLES_DIR = ROOT / "docs/spec-db/ai-eda/examples"
CLAIM_BOUNDARY = "internal_dataset_schema_validation_only_no_training_inference_or_release_claim"


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def validate_nested(
    record_id: str,
    document: dict[str, Any],
    nested_requirements: dict[str, list[str]],
) -> list[str]:
    errors: list[str] = []
    for parent, fields in nested_requirements.items():
        value = document.get(parent)
        if not isinstance(value, dict):
            errors.append(f"{record_id}: {parent} must be a mapping")
            continue
        for field in fields:
            if field not in value:
                errors.append(f"{record_id}: {parent}.{field} is required")
    return errors


def validate_document(label: str, document: Any, records: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return [f"{label}: example must be a mapping"]
    schema_id = document.get("schema")
    if not isinstance(schema_id, str) or schema_id not in records:
        return [f"{label}: unknown schema {schema_id!r}"]

    record = records[schema_id]
    record_id = document.get("id", label)
    for field in record.get("required_fields", []):
        if field not in document:
            errors.append(f"{record_id}: missing required field {field}")
    errors.extend(validate_nested(record_id, document, record.get("required_nested", {})))

    claim_boundary = document.get("claim_boundary")
    if not isinstance(claim_boundary, str) or not claim_boundary:
        errors.append(f"{record_id}: claim_boundary must be a non-empty string")
    elif "release_claim" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must explicitly forbid release claims")

    return errors


def validate_example(path: Path, records: dict[str, Any]) -> list[str]:
    return validate_document(str(path), load_yaml(path), records)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema-file", type=Path, default=SCHEMA_FILE)
    parser.add_argument("--examples-dir", type=Path, default=EXAMPLES_DIR)
    parser.add_argument(
        "--records-dir",
        action="append",
        type=Path,
        default=[],
        help="Additional JSON/YAML records to validate against the internal schemas.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    if not args.schema_file.exists():
        print(f"STATUS: FAIL ai_eda.internal_dataset_schemas missing_schema {args.schema_file}")
        return 1
    schema = load_yaml(args.schema_file)
    if not isinstance(schema, dict):
        print(f"STATUS: FAIL ai_eda.internal_dataset_schemas invalid_schema {args.schema_file}")
        return 1
    if schema.get("schema") != "eliza.ai_eda.internal_dataset_schemas.v1":
        errors.append("schema id must be eliza.ai_eda.internal_dataset_schemas.v1")
    if (
        schema.get("claim_boundary")
        != "schema_contract_only_no_training_inference_or_release_claim"
    ):
        errors.append("top-level claim_boundary is missing or incorrect")

    policy = schema.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "ai_outputs_are_advisory_until_replayed",
            "deterministic_replay_required_for_evidence",
            "generated_artifacts_must_stay_under_build_ai_eda",
            "source_rtl_modification_forbidden_by_schema",
        ):
            if policy.get(field) is not True:
                errors.append(f"policy.{field} must be true")

    records = schema.get("records")
    if not isinstance(records, dict) or not records:
        errors.append("records must be a non-empty mapping")
        records = {}
    else:
        for record_id, record in records.items():
            if not isinstance(record, dict):
                errors.append(f"{record_id}: record spec must be a mapping")
                continue
            required = record.get("required_fields")
            if not isinstance(required, list) or "schema" not in required or "claim_boundary" not in required:
                errors.append(f"{record_id}: required_fields must include schema and claim_boundary")
            nested = record.get("required_nested")
            if not isinstance(nested, dict):
                errors.append(f"{record_id}: required_nested must be a mapping")

    examples = sorted(args.examples_dir.glob("*.yaml")) if args.examples_dir.exists() else []
    if not examples:
        errors.append(f"no example fixtures found in {args.examples_dir}")
    seen_schema_examples: set[str] = set()
    for path in examples:
        document = load_yaml(path)
        if isinstance(document, dict) and isinstance(document.get("schema"), str):
            seen_schema_examples.add(document["schema"])
        errors.extend(validate_example(path, records))

    missing_examples = sorted(set(records) - seen_schema_examples)
    for record_id in missing_examples:
        errors.append(f"{record_id}: missing example fixture")

    extra_records = []
    for records_dir in args.records_dir:
        if not records_dir.exists():
            errors.append(f"records directory does not exist: {records_dir}")
            continue
        extra_records.extend(sorted(records_dir.glob("*.json")))
        extra_records.extend(sorted(records_dir.glob("*.yaml")))
    for path in extra_records:
        try:
            if path.suffix == ".json":
                import json

                document = json.loads(path.read_text(encoding="utf-8"))
            else:
                document = load_yaml(path)
            if not isinstance(document, dict):
                errors.append(f"{path}: record must be a mapping")
                continue
            schema_id = document.get("schema")
            if not isinstance(schema_id, str) or schema_id not in records:
                errors.append(f"{path}: unknown schema {schema_id!r}")
                continue
            errors.extend(validate_document(str(path), document, records))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path}: {exc}")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.internal_dataset_schemas {error}")
        return 1

    print(
        "STATUS: PASS ai_eda.internal_dataset_schemas "
        f"records={len(records)} examples={len(examples)} "
        f"extra_records={len(extra_records)} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
