#!/usr/bin/env python3
"""Validate deterministic FloorSet Lite split manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/floorset_lite_splits/validation/split_manifest.json"
EXPECTED_SCHEMA = "eliza.ai_eda.floorset_lite_split_manifest.v1"
EXPECTED_CLAIM_BOUNDARY = "floorset_lite_split_manifest_training_only_no_e1_signoff_or_release_claim"
REQUIRED_SPLITS = {"train", "val", "test"}


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


def validate_artifact(item: Any, label: str) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    if item.get("status") != "PRESENT":
        return [f"{label}.status must be PRESENT"]
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    path = repo_path(path_value)
    if not path.is_file():
        return [f"{label}.path missing on disk"]
    if item.get("sha256") != sha256_file(path):
        return [f"{label}.sha256 is stale"]
    return []


def validate_record(item: Any, label: str) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}.path must be present")
    else:
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
    if item.get("schema") not in {"eda.design_bundle.v1", "eda.graph_sample.v1", "eda.flow_run.v1"}:
        errors.append(f"{label}.schema is invalid")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("training_use_allowed") is not True:
        errors.append("training_use_allowed must be true")
    if report.get("e1_signoff_evidence") is not False:
        errors.append("e1_signoff_evidence must be false")
    if report.get("optimization_claim_allowed") is not False:
        errors.append("optimization_claim_allowed must be false")
    errors.extend(validate_artifact(report.get("source_conversion"), "source_conversion"))
    splits = report.get("splits")
    if not isinstance(splits, dict) or set(splits) != REQUIRED_SPLITS:
        return errors + ["splits must contain train/val/test"]
    case_ids: set[str] = set()
    record_count = 0
    for split, cases in splits.items():
        if not isinstance(cases, list) or not cases:
            errors.append(f"{split} split must be non-empty")
            continue
        for case_index, case in enumerate(cases):
            label = f"{split}[{case_index}]"
            if not isinstance(case, dict):
                errors.append(f"{label} must be a mapping")
                continue
            case_id = case.get("case_id")
            if not isinstance(case_id, str) or not case_id:
                errors.append(f"{label}.case_id must be present")
            elif case_id in case_ids:
                errors.append(f"{label}.case_id duplicated")
            else:
                case_ids.add(case_id)
            records = case.get("records")
            if not isinstance(records, list) or len(records) != 3:
                errors.append(f"{label}.records must contain design/graph/flow")
            else:
                record_count += len(records)
                for record_index, record in enumerate(records):
                    errors.extend(validate_record(record, f"{label}.records[{record_index}]"))
    if len(case_ids) != 100:
        errors.append("manifest must cover 100 cases")
    if record_count != 300:
        errors.append("manifest must cover 300 records")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    else:
        if summary.get("case_count") != 100:
            errors.append("summary.case_count must be 100")
        if summary.get("record_count") != 300:
            errors.append("summary.record_count must be 300")
        if summary.get("split_counts") != {"test": 10, "train": 80, "val": 10}:
            errors.append("summary.split_counts mismatch")
    review = report.get("contamination_review")
    if not isinstance(review, dict) or review.get("status") != "PASS":
        errors.append("contamination_review.status must be PASS")
    if report.get("blockers") != []:
        errors.append("blockers must be empty")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.floorset_split_manifest missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.floorset_split_manifest {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.floorset_split_manifest {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.floorset_split_manifest "
        f"cases={report['summary']['case_count']} records={report['summary']['record_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
