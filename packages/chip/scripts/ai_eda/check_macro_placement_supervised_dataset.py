#!/usr/bin/env python3
"""Validate supervised macro-placement JSONL datasets and split reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT
    / "build/ai_eda/macro_placement_supervised_dataset/validation/macro_placement_supervised_dataset_report.json"
)
CLAIM_BOUNDARY = (
    "macro_placement_supervised_dataset_validation_only_no_training_inference_or_release_claim"
)
DATASET_CLAIM_BOUNDARY = (
    "macro_placement_supervised_dataset_only_no_training_inference_ppa_or_release_claim"
)
REQUIRED_SPLITS = ("train", "val", "test")


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


def validate_sample(
    sample: dict[str, Any], split: str, source_path: Path, line_number: int
) -> list[str]:
    errors: list[str] = []
    sample_id = sample.get("id", f"{rel(source_path)}:{line_number}")
    if sample.get("schema") != "eliza.ai_eda.macro_placement_supervised_sample.v1":
        errors.append(f"{sample_id}: invalid sample schema")
    if sample.get("claim_boundary") != DATASET_CLAIM_BOUNDARY:
        errors.append(f"{sample_id}: invalid claim_boundary")
    if sample.get("split") != split:
        errors.append(f"{sample_id}: split field does not match file split {split}")
    for field in (
        "id",
        "source_record",
        "case_id",
        "design_bundle_id",
        "object",
        "floorplan",
        "label",
    ):
        if field not in sample:
            errors.append(f"{sample_id}: missing required field {field}")

    obj = sample.get("object")
    if not isinstance(obj, dict):
        errors.append(f"{sample_id}: object must be a mapping")
    else:
        for field in ("id", "index", "type", "width_um", "height_um", "size_status"):
            if field not in obj:
                errors.append(f"{sample_id}: object.{field} is required")
        if obj.get("size_status") not in {"source_lef_size", "fallback_missing_lef_size"}:
            errors.append(f"{sample_id}: unsupported object.size_status {obj.get('size_status')!r}")
        for field in ("width_um", "height_um"):
            value = obj.get(field)
            if not isinstance(value, (int, float)) or value <= 0:
                errors.append(f"{sample_id}: object.{field} must be positive")

    floorplan = sample.get("floorplan")
    if not isinstance(floorplan, dict):
        errors.append(f"{sample_id}: floorplan must be a mapping")
    else:
        for field in ("die_area_um", "core_area_um", "core_width_um", "core_height_um"):
            if field not in floorplan:
                errors.append(f"{sample_id}: floorplan.{field} is required")
        for field in ("core_width_um", "core_height_um"):
            value = floorplan.get(field)
            if not isinstance(value, (int, float)) or value <= 0:
                errors.append(f"{sample_id}: floorplan.{field} must be positive")

    label = sample.get("label")
    if not isinstance(label, dict):
        errors.append(f"{sample_id}: label must be a mapping")
    else:
        for field in ("x_um", "y_um", "orientation", "x_over_core", "y_over_core"):
            if field not in label:
                errors.append(f"{sample_id}: label.{field} is required")
        for field in ("x_over_core", "y_over_core"):
            value = label.get(field)
            if not isinstance(value, (int, float)) or value < -0.25 or value > 1.25:
                errors.append(f"{sample_id}: label.{field} is outside sanity bounds")
    return errors


def validate_report(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.ai_eda.macro_placement_supervised_dataset_report.v1":
        errors.append(
            "report schema must be eliza.ai_eda.macro_placement_supervised_dataset_report.v1"
        )
    if report.get("claim_boundary") != DATASET_CLAIM_BOUNDARY:
        errors.append("report claim_boundary is missing or incorrect")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")

    splits = report.get("splits")
    if not isinstance(splits, dict):
        errors.append("splits must be a mapping")
        return errors
    split_counts_report = report.get("split_counts")
    if not isinstance(split_counts_report, dict):
        errors.append("split_counts must be a mapping")
        split_counts_report = {}
    case_split_counts_report = report.get("case_split_counts")
    if not isinstance(case_split_counts_report, dict):
        errors.append("case_split_counts must be a mapping")
        case_split_counts_report = {}

    seen_ids: set[str] = set()
    case_to_split: dict[str, str] = {}
    split_counts: dict[str, int] = {}
    fallback_size_count = 0
    for split in REQUIRED_SPLITS:
        split_path_value = splits.get(split)
        if not isinstance(split_path_value, str):
            errors.append(f"splits.{split} must be a path")
            continue
        split_path = repo_path(split_path_value)
        if not split_path.exists():
            errors.append(f"missing split file {rel(split_path)}")
            continue
        count = 0
        with split_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                count += 1
                try:
                    sample = json.loads(line)
                except json.JSONDecodeError as exc:
                    errors.append(f"{rel(split_path)}:{line_number}: invalid json: {exc}")
                    continue
                if not isinstance(sample, dict):
                    errors.append(f"{rel(split_path)}:{line_number}: sample must be an object")
                    continue
                errors.extend(validate_sample(sample, split, split_path, line_number))
                sample_id = str(sample.get("id", ""))
                if sample_id in seen_ids:
                    errors.append(f"{sample_id}: duplicate sample id")
                seen_ids.add(sample_id)
                case_id = str(sample.get("case_id", ""))
                prior_split = case_to_split.setdefault(case_id, split)
                if prior_split != split:
                    errors.append(f"{case_id}: case leaks across {prior_split} and {split}")
                obj = sample.get("object")
                if isinstance(obj, dict) and obj.get("size_status") == "fallback_missing_lef_size":
                    fallback_size_count += 1
        split_counts[split] = count
        if split_counts_report.get(split) != count:
            errors.append(f"split_counts.{split} does not match {rel(split_path)}")

    sample_count = sum(split_counts.values())
    if report.get("sample_count") != sample_count:
        errors.append("sample_count does not match split files")
    if report.get("labeled_case_count") != len(case_to_split):
        errors.append("labeled_case_count does not match split files")
    if report.get("fallback_size_sample_count") != fallback_size_count:
        errors.append("fallback_size_sample_count does not match split files")
    computed_case_split_counts = {split: 0 for split in REQUIRED_SPLITS}
    for split in case_to_split.values():
        computed_case_split_counts[split] += 1
    for split, count in computed_case_split_counts.items():
        if case_split_counts_report.get(split) != count:
            errors.append(f"case_split_counts.{split} does not match split files")

    skipped = report.get("skipped_cases")
    if not isinstance(skipped, list):
        errors.append("skipped_cases must be a list")
    elif report.get("skipped_case_count") != len(skipped):
        errors.append("skipped_case_count does not match skipped_cases")

    if sample_count <= 0:
        errors.append("dataset has no samples")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(
            f"STATUS: FAIL ai_eda.macro_placement_supervised_dataset missing_report {args.report}"
        )
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.macro_placement_supervised_dataset {args.report}: {exc}")
        return 1
    errors = validate_report(report, args.report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_supervised_dataset {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_supervised_dataset "
        f"samples={report['sample_count']} cases={report['labeled_case_count']} "
        f"claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
