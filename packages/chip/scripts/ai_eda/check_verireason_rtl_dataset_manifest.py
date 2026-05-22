#!/usr/bin/env python3
"""Validate VeriReason RTL-Coder dataset integrity manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/verireason_rtl_datasets/validation/dataset_manifest.json"
EXPECTED_SCHEMA = "eliza.ai_eda.verireason_rtl_dataset_manifest.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "verireason_rtl_dataset_manifest_training_only_no_rtl_execution_or_e1_signoff_claim"
)
EXPECTED_STATUS = "VERIFIED_VERIREASON_RTL_DATASETS"
EXPECTED_DATASET_COUNT = 4
EXPECTED_JSONL_FILE_COUNT = 5
EXPECTED_JSONL_ROW_COUNT = 6433
EXPECTED_JSONL_TOTAL_BYTES = 41677210
EXPECTED_DATASETS = {
    "verireason-rtl-coder-small",
    "verireason-rtl-coder-reasoning-simple",
    "verireason-rtl-coder-reasoning-hard",
    "verireason-rtl-coder-reasoning-combined",
}


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


def count_jsonl_rows(path: Path) -> int:
    with path.open("rb") as handle:
        return sum(1 for _ in handle)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_file(item: Any, label: str) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    if item.get("status") != "VERIFIED":
        errors.append(f"{label}.status must be VERIFIED")
    if item.get("present") is not True:
        errors.append(f"{label}.present must be true")
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}.path must be present")
        return errors
    path = repo_path(path_value)
    if not path.is_file():
        errors.append(f"{label}.path missing on disk")
        return errors
    if item.get("actual_rows") != count_jsonl_rows(path):
        errors.append(f"{label}.actual_rows is stale")
    if item.get("expected_rows") != count_jsonl_rows(path):
        errors.append(f"{label}.expected_rows does not match file")
    if item.get("actual_size_bytes") != path.stat().st_size:
        errors.append(f"{label}.actual_size_bytes is stale")
    if item.get("expected_size_bytes") != path.stat().st_size:
        errors.append(f"{label}.expected_size_bytes does not match file")
    digest = sha256_file(path)
    if item.get("actual_sha256") != digest:
        errors.append(f"{label}.actual_sha256 is stale")
    if item.get("expected_sha256") != digest:
        errors.append(f"{label}.expected_sha256 does not match file")
    required_fields = item.get("required_fields")
    first_row_keys = item.get("first_row_keys")
    if not isinstance(required_fields, list) or not required_fields:
        errors.append(f"{label}.required_fields must be non-empty")
    if not isinstance(first_row_keys, list) or not set(required_fields or []).issubset(
        first_row_keys
    ):
        errors.append(f"{label}.first_row_keys missing required fields")
    if item.get("errors") != []:
        errors.append(f"{label}.errors must be empty")
    if item.get("missing_required_fields") != []:
        errors.append(f"{label}.missing_required_fields must be empty")
    return errors


def validate_readme(item: Any, label: str) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    if item.get("present") is not True:
        errors.append(f"{label}.present must be true")
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}.path must be present")
        return errors
    path = repo_path(path_value)
    if not path.is_file():
        errors.append(f"{label}.path missing on disk")
        return errors
    if item.get("size_bytes") != path.stat().st_size:
        errors.append(f"{label}.size_bytes is stale")
    if item.get("sha256") != sha256_file(path):
        errors.append(f"{label}.sha256 is stale")
    return errors


def validate_dataset(item: Any, index: int) -> tuple[str | None, list[str]]:
    if not isinstance(item, dict):
        return None, [f"datasets[{index}] must be a mapping"]
    label = f"datasets[{index}]"
    errors: list[str] = []
    asset_id = item.get("asset_id")
    if not isinstance(asset_id, str) or asset_id not in EXPECTED_DATASETS:
        errors.append(f"{label}.asset_id is unexpected")
    if item.get("status") != "VERIFIED_TRAINING_ONLY_JSONL_PAYLOAD":
        errors.append(f"{label}.status must be VERIFIED_TRAINING_ONLY_JSONL_PAYLOAD")
    if item.get("revision_status") != "VERIFIED":
        errors.append(f"{label}.revision_status must be VERIFIED")
    if item.get("expected_revision") != item.get("actual_revision"):
        errors.append(f"{label}.actual_revision mismatch")
    if item.get("license_status") != "dataset_card_review_required":
        errors.append(f"{label}.license_status mismatch")
    if item.get("allowed_use") != "training-only":
        errors.append(f"{label}.allowed_use mismatch")
    if item.get("release_use_allowed") is not False:
        errors.append(f"{label}.release_use_allowed must be false")
    if item.get("generated_rtl_quarantined") is not True:
        errors.append(f"{label}.generated_rtl_quarantined must be true")
    if item.get("testbench_feedback_quarantined") is not True:
        errors.append(f"{label}.testbench_feedback_quarantined must be true")
    files = item.get("files")
    if not isinstance(files, list) or not files:
        errors.append(f"{label}.files must be non-empty")
    else:
        for file_index, file_item in enumerate(files):
            errors.extend(validate_file(file_item, f"{label}.files[{file_index}]"))
    errors.extend(validate_readme(item.get("readme"), f"{label}.readme"))
    if item.get("blockers") != []:
        errors.append(f"{label}.blockers must be empty")
    if isinstance(files, list):
        row_count = sum(
            int(file_item.get("actual_rows", 0))
            for file_item in files
            if isinstance(file_item, dict)
        )
        total_bytes = sum(
            int(file_item.get("actual_size_bytes", 0))
            for file_item in files
            if isinstance(file_item, dict)
        )
        if item.get("jsonl_row_count") != row_count:
            errors.append(f"{label}.jsonl_row_count mismatch")
        if item.get("jsonl_total_bytes") != total_bytes:
            errors.append(f"{label}.jsonl_total_bytes mismatch")
    return asset_id if isinstance(asset_id, str) else None, errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("status") != EXPECTED_STATUS:
        errors.append("status mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("training_use_allowed") is not True:
        errors.append("training_use_allowed must be true")
    if report.get("rtl_execution_claim_allowed") is not False:
        errors.append("rtl_execution_claim_allowed must be false")
    if report.get("e1_signoff_evidence") is not False:
        errors.append("e1_signoff_evidence must be false")
    if report.get("optimization_claim_allowed") is not False:
        errors.append("optimization_claim_allowed must be false")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    else:
        if summary.get("dataset_count") != EXPECTED_DATASET_COUNT:
            errors.append("summary.dataset_count mismatch")
        if summary.get("jsonl_file_count") != EXPECTED_JSONL_FILE_COUNT:
            errors.append("summary.jsonl_file_count mismatch")
        if summary.get("jsonl_row_count") != EXPECTED_JSONL_ROW_COUNT:
            errors.append("summary.jsonl_row_count mismatch")
        if summary.get("jsonl_total_bytes") != EXPECTED_JSONL_TOTAL_BYTES:
            errors.append("summary.jsonl_total_bytes mismatch")
        if summary.get("blocker_count") != 0:
            errors.append("summary.blocker_count must be zero")
    review = report.get("contamination_review")
    if not isinstance(review, dict) or review.get("status") != "TRAINING_ONLY_QUARANTINE":
        errors.append("contamination_review.status mismatch")
    datasets = report.get("datasets")
    if not isinstance(datasets, list):
        return errors + ["datasets must be a list"]
    seen: set[str] = set()
    for index, dataset in enumerate(datasets):
        asset_id, dataset_errors = validate_dataset(dataset, index)
        errors.extend(dataset_errors)
        if asset_id in seen:
            errors.append(f"{asset_id}: duplicate dataset")
        elif asset_id:
            seen.add(asset_id)
    if seen != EXPECTED_DATASETS:
        errors.append("dataset asset set mismatch")
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
        print(
            f"STATUS: FAIL ai_eda.verireason_rtl_dataset_manifest missing_report {rel(args.report)}"
        )
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.verireason_rtl_dataset_manifest {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.verireason_rtl_dataset_manifest {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.verireason_rtl_dataset_manifest "
        f"datasets={report['summary']['dataset_count']} rows={report['summary']['jsonl_row_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
