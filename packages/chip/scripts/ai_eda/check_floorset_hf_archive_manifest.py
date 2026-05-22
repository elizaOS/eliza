#!/usr/bin/env python3
"""Validate local Hugging Face FloorSet archive hash manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/floorset_hf_archives/validation/archive_manifest.json"
EXPECTED_SCHEMA = "eliza.ai_eda.floorset_hf_archive_manifest.v1"
EXPECTED_CLAIM_BOUNDARY = "floorset_hf_archive_hash_manifest_no_unpack_training_or_release_claim"
EXPECTED_STATUS = "VERIFIED_FULL_HF_ARCHIVE_SET"
EXPECTED_ARCHIVE_COUNT = 10
EXPECTED_TOTAL_BYTES = 29665773263


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


def validate_archive(record: Any, index: int) -> list[str]:
    if not isinstance(record, dict):
        return [f"archives[{index}] must be a mapping"]
    errors: list[str] = []
    filename = record.get("filename", f"archives[{index}]")
    if record.get("status") != "VERIFIED":
        errors.append(f"{filename}: status must be VERIFIED")
    if record.get("present") is not True:
        errors.append(f"{filename}: present must be true")
    if record.get("required") is not True:
        errors.append(f"{filename}: required must be true")
    path_value = record.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{filename}: path must be present")
        return errors
    path = repo_path(path_value)
    if not path.is_file():
        errors.append(f"{filename}: file is missing on disk")
        return errors
    if record.get("actual_size_bytes") != path.stat().st_size:
        errors.append(f"{filename}: actual_size_bytes is stale")
    if record.get("expected_size_bytes") != path.stat().st_size:
        errors.append(f"{filename}: expected_size_bytes does not match file")
    expected_sha = record.get("expected_sha256")
    actual_sha = record.get("actual_sha256")
    if expected_sha is not None:
        digest = sha256_file(path)
        if actual_sha != digest:
            errors.append(f"{filename}: actual_sha256 is stale")
        if expected_sha != digest:
            errors.append(f"{filename}: expected_sha256 does not match file")
    elif actual_sha is not None:
        errors.append(f"{filename}: actual_sha256 must be omitted for unhashed tiny metadata")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("dataset_id") != "IntelLabs/FloorSet":
        errors.append("dataset_id mismatch")
    if report.get("status") != EXPECTED_STATUS:
        errors.append("status must be VERIFIED_FULL_HF_ARCHIVE_SET")
    if report.get("archive_count") != EXPECTED_ARCHIVE_COUNT:
        errors.append("archive_count mismatch")
    if report.get("verified_archive_count") != EXPECTED_ARCHIVE_COUNT:
        errors.append("verified_archive_count mismatch")
    if report.get("expected_total_bytes") != EXPECTED_TOTAL_BYTES:
        errors.append("expected_total_bytes mismatch")
    if report.get("verified_total_bytes") != EXPECTED_TOTAL_BYTES:
        errors.append("verified_total_bytes mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("training_use_allowed") is not True:
        errors.append("training_use_allowed must be true")
    if report.get("unpack_claim_allowed") is not False:
        errors.append("unpack_claim_allowed must be false")
    if report.get("e1_signoff_claim_allowed") is not False:
        errors.append("e1_signoff_claim_allowed must be false")
    if report.get("blockers") != []:
        errors.append("blockers must be empty")
    archives = report.get("archives")
    if not isinstance(archives, list):
        return errors + ["archives must be a list"]
    for index, archive in enumerate(archives):
        errors.extend(validate_archive(archive, index))
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.floorset_hf_archive_manifest missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.floorset_hf_archive_manifest {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.floorset_hf_archive_manifest {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.floorset_hf_archive_manifest "
        f"archives={report['archive_count']} bytes={report['verified_total_bytes']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
