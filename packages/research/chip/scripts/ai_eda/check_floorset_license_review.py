#!/usr/bin/env python3
"""Validate FloorSet license/provenance review reports."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/floorset_license_review/validation/license_review.json"
EXPECTED_SCHEMA = "eliza.ai_eda.floorset_license_review.v1"
EXPECTED_CLAIM_BOUNDARY = "floorset_license_review_training_only_no_release_or_legal_advice_claim"
DECLARED_EVIDENCE_STATUSES = {
    "DECLARED_IN_REVIEWED_INTAKE",
    "RECORDED_IN_REVIEWED_INTAKE",
}
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "commercial_use_allowed": False,
    "model_weight_release_allowed": False,
    "e1_signoff_claim_allowed": False,
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


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_artifact(item: Any, label: str, *, allow_declared: bool = False) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    status = item.get("status")
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    if allow_declared and status in DECLARED_EVIDENCE_STATUSES:
        source = item.get("source")
        if not isinstance(source, str) or not source:
            return [f"{label}.source must name the reviewed intake metadata"]
        if item.get("sha256") is not None or item.get("size_bytes") is not None:
            return [f"{label} declared external evidence must not pretend to hash ignored payloads"]
        return []
    if status != "PRESENT":
        expected = "PRESENT or reviewed-intake declaration" if allow_declared else "PRESENT"
        return [f"{label}.status must be {expected}"]
    path = repo_path(path_value)
    if not path.is_file():
        return [f"{label}.path missing on disk"]
    if item.get("sha256") != sha256_file(path):
        return [f"{label}.sha256 is stale"]
    return []


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("asset_id") != "intel-floorset":
        errors.append("asset_id mismatch")
    if report.get("status") != "TRAINING_ONLY_REVIEW_COMPLETE":
        errors.append("status must be TRAINING_ONLY_REVIEW_COMPLETE")
    if report.get("legal_advice") is not False:
        errors.append("legal_advice must be false")
    findings = report.get("license_findings")
    if not isinstance(findings, dict):
        errors.append("license_findings must be a mapping")
    else:
        if findings.get("repository_license_family") != "Apache-2.0":
            errors.append("repository_license_family must be Apache-2.0")
        if findings.get("dataset_license_family") != "CC-BY-4.0":
            errors.append("dataset_license_family must be CC-BY-4.0")
        if findings.get("contest_framework_present") is not True:
            errors.append("contest_framework_present must be true")
    allowed = report.get("allowed_use")
    if not isinstance(allowed, dict):
        errors.append("allowed_use must be a mapping")
    else:
        for field in ("metadata_review", "local_research_training", "cuda_training_handoff"):
            if allowed.get(field) is not True:
                errors.append(f"allowed_use.{field} must be true")
        for field in (
            "release_use_allowed",
            "commercial_use_allowed",
            "model_weight_release_allowed",
            "e1_signoff_claim_allowed",
        ):
            if allowed.get(field) is not False:
                errors.append(f"allowed_use.{field} must be false")
        if allowed.get("false_claim_flags") != FALSE_CLAIM_FLAGS:
            errors.append("allowed_use.false_claim_flags must match denied FloorSet license claims")
    evidence = report.get("evidence")
    if not isinstance(evidence, dict):
        errors.append("evidence must be a mapping")
    else:
        for field in (
            "root_license",
            "root_readme",
            "contest_readme",
            "contest_spec_pdf",
            "fetch_verification_report",
        ):
            errors.extend(
                validate_artifact(evidence.get(field), f"evidence.{field}", allow_declared=True)
            )
        for field in (
            "intake_manifest",
            "source_lock",
        ):
            errors.extend(validate_artifact(evidence.get(field), f"evidence.{field}"))
    controls = report.get("required_controls")
    if not isinstance(controls, list) or len(controls) < 4:
        errors.append("required_controls must be concrete")
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
        print(f"STATUS: FAIL ai_eda.floorset_license_review missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.floorset_license_review {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.floorset_license_review {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.floorset_license_review "
        f"status={report['status']} release_use_allowed={report['allowed_use']['release_use_allowed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
