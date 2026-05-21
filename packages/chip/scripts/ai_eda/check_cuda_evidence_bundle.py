#!/usr/bin/env python3
"""Validate hash-pinned CUDA readiness evidence bundle manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SCHEMA = "eliza.ai_eda.cuda_evidence_bundle.v1"
EXPECTED_CLAIM_BOUNDARY = "cuda_evidence_bundle_manifest_only_no_training_inference_or_release_claim"


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
        raise ValueError(f"{rel(path)} must contain a JSON object")
    return data


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in (
            "contains_datasets",
            "contains_model_weights",
            "runs_training",
            "runs_inference",
            "runs_openlane",
            "release_use_allowed",
        ):
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
    audit_path_value = report.get("source_readiness_audit")
    if not isinstance(audit_path_value, str) or not audit_path_value:
        errors.append("source_readiness_audit must be present")
    else:
        audit_path = repo_path(audit_path_value)
        if not audit_path.is_file():
            errors.append("source_readiness_audit missing on disk")
        elif sha256_file(audit_path) != report.get("source_readiness_audit_sha256"):
            errors.append("source_readiness_audit_sha256 is stale")
    if report.get("readiness_status") not in {"READY_FOR_CUDA_EXECUTION", "PASS_WITH_BLOCKERS_RECORDED"}:
        errors.append("readiness_status mismatch")
    if not isinstance(report.get("evidence_run_ids"), dict) or not report["evidence_run_ids"]:
        errors.append("evidence_run_ids must be a non-empty mapping")
    if not isinstance(report.get("capabilities"), dict) or not report["capabilities"]:
        errors.append("capabilities must be a non-empty mapping")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        return errors + ["artifacts must be a non-empty list"]
    if report.get("artifact_count") != len(artifacts):
        errors.append("artifact_count mismatch")
    present_count = 0
    missing_count = 0
    seen_paths: set[str] = set()
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            errors.append(f"artifacts[{index}] must be a mapping")
            continue
        path_value = artifact.get("path")
        status = artifact.get("status")
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"artifacts[{index}].path must be present")
            continue
        if path_value in seen_paths:
            errors.append(f"{path_value}: duplicate artifact path")
        seen_paths.add(path_value)
        if status == "PRESENT":
            present_count += 1
            path = repo_path(path_value)
            if not path.is_file():
                errors.append(f"{path_value}: marked present but missing on disk")
            elif sha256_file(path) != artifact.get("sha256"):
                errors.append(f"{path_value}: sha256 is stale")
            if not isinstance(artifact.get("size_bytes"), int) or artifact["size_bytes"] <= 0:
                errors.append(f"{path_value}: size_bytes must be positive for present artifact")
        elif status == "MISSING":
            missing_count += 1
            if artifact.get("sha256") is not None:
                errors.append(f"{path_value}: missing artifact must not have sha256")
        else:
            errors.append(f"{path_value}: status must be PRESENT or MISSING")
    if report.get("present_artifact_count") != present_count:
        errors.append("present_artifact_count mismatch")
    if report.get("missing_artifact_count") != missing_count:
        errors.append("missing_artifact_count mismatch")
    commands = report.get("replay_commands")
    if not isinstance(commands, list) or len(commands) < 3:
        errors.append("replay_commands must include check/package/check commands")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report_path = repo_path(str(args.report))
    if not report_path.is_file():
        print(f"STATUS: FAIL ai_eda.cuda_evidence_bundle_check missing_report {rel(report_path)}")
        return 1
    try:
        report = load_json(report_path)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.cuda_evidence_bundle_check {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cuda_evidence_bundle_check {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.cuda_evidence_bundle_check "
        f"artifacts={report['artifact_count']} present={report['present_artifact_count']} missing={report['missing_artifact_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
