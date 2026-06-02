#!/usr/bin/env python3
"""Capture a conservative FloorSet license/provenance review."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorset_license_review"
SCHEMA = "eliza.ai_eda.floorset_license_review.v1"
CLAIM_BOUNDARY = "floorset_license_review_training_only_no_release_or_legal_advice_claim"
ASSET_ID = "intel-floorset"
LICENSE_STATUS_COMPLETE = "training_only_review_complete_apache-2.0_repo_cc-by-4.0_dataset"
FLOORSET_VERIFY_RUN_ID = "codex-floorset-verify-20260521"
DECLARED_INTAKE_STATUS = "DECLARED_IN_REVIEWED_INTAKE"
RECORDED_INTAKE_STATUS = "RECORDED_IN_REVIEWED_INTAKE"
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


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def declared_artifact(path: Path, status: str, source: str) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": status,
        "sha256": None,
        "size_bytes": None,
        "source": source,
    }


def artifact_or_declared(
    path: Path, status: str, source: str, *, allow_declared: bool
) -> dict[str, Any]:
    if path.is_file():
        return artifact(path)
    if allow_declared:
        return declared_artifact(path, status, source)
    return artifact(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def source_lock_entry(lockfile: dict[str, Any]) -> dict[str, Any]:
    entries = lockfile.get("entries")
    if not isinstance(entries, list):
        return {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id") == ASSET_ID:
            return entry
    return {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = ROOT / "external/datasets/intel-floorset/payload"
    intake_manifest = ROOT / "external/datasets/intel-floorset/manifest.yaml"
    lockfile = ROOT / "external/SOURCES.lock.yaml"
    root_license = payload / "LICENSE"
    root_readme = payload / "README.md"
    contest_readme = payload / "iccad2026contest/README.md"
    contest_pdf = payload / "iccad2026contest/FloorplanningContest_ICCAD_2026_v9.pdf"
    verify_report = (
        ROOT / "build/ai_eda/external_assets/codex-floorset-verify-20260521/intel-floorset.json"
    )
    intake = load_yaml(intake_manifest)
    lock = load_yaml(lockfile)
    lock_entry = source_lock_entry(lock)
    license_info = as_mapping(intake.get("license"))
    intake_info = as_mapping(intake.get("intake"))
    payload_info = as_mapping(intake.get("local_payload"))
    lock_validation = as_mapping(lock_entry.get("validation"))
    checksum_status = str(payload_info.get("checksum_status", ""))
    lock_checksum_status = str(lock_entry.get("checksum_status", ""))
    metadata_review_blockers: list[str] = []
    if license_info.get("status") != LICENSE_STATUS_COMPLETE:
        metadata_review_blockers.append(
            "intake manifest does not record complete training-only FloorSet license status"
        )
    if intake_info.get("review_status") != "metadata_reviewed":
        metadata_review_blockers.append("intake manifest review_status is not metadata_reviewed")
    if intake_info.get("allowed_use") != "training-only":
        metadata_review_blockers.append("intake manifest allowed_use is not training-only")
    if intake_info.get("release_use_allowed") is not False:
        metadata_review_blockers.append("intake manifest must keep release_use_allowed=false")
    if lock_entry.get("allowed_use") != "training-only":
        metadata_review_blockers.append("source lock allowed_use is not training-only")
    if lock_validation.get("license_review") != "complete_training_only_2026-05-21":
        metadata_review_blockers.append(
            "source lock license_review is not complete_training_only_2026-05-21"
        )
    if lock_validation.get("provenance_review") != "complete":
        metadata_review_blockers.append("source lock provenance_review is not complete")
    if lock_validation.get("hash_verification") != "complete":
        metadata_review_blockers.append("source lock hash_verification is not complete")
    if (
        FLOORSET_VERIFY_RUN_ID not in checksum_status
        or FLOORSET_VERIFY_RUN_ID not in lock_checksum_status
    ):
        metadata_review_blockers.append(
            "FloorSet verification run id is not recorded in intake and source lock checksum status"
        )

    license_text = read_text(root_license)
    readme_text = read_text(root_readme)
    contest_text = read_text(contest_readme)
    blockers: list[str] = []
    metadata_review_complete = not metadata_review_blockers
    root_license_bad = root_license.is_file() and "Apache License" not in license_text
    root_license_missing_without_metadata = (
        not root_license.is_file() and not metadata_review_complete
    )
    if root_license_bad or root_license_missing_without_metadata:
        blockers.append("root LICENSE does not identify Apache-2.0")
    root_readme_bad = (
        root_readme.is_file()
        and "Creative Commons Attribution 4.0 International License" not in readme_text
    )
    root_readme_missing_without_metadata = (
        not root_readme.is_file() and not metadata_review_complete
    )
    if root_readme_bad or root_readme_missing_without_metadata:
        blockers.append("README does not identify dataset CC BY 4.0 terms")
    contest_readme_bad = contest_readme.is_file() and "ICCAD 2026" not in contest_text
    contest_readme_missing_without_metadata = (
        not contest_readme.is_file() and not metadata_review_complete
    )
    if contest_readme_bad or contest_readme_missing_without_metadata:
        blockers.append("contest README evidence is missing ICCAD 2026 context")
    for path, label in (
        (intake_manifest, "external intake manifest"),
        (lockfile, "external source lock"),
    ):
        if not path.is_file():
            blockers.append(f"{label} is missing")
    if not verify_report.is_file() and not metadata_review_complete:
        blockers.append("fetch verification report is missing")
    blockers.extend(metadata_review_blockers)

    status = "TRAINING_ONLY_REVIEW_COMPLETE" if not blockers else "REVIEW_INCOMPLETE"
    reviewed_metadata_source = (
        "external/datasets/intel-floorset/manifest.yaml + external/SOURCES.lock.yaml"
    )
    allow_declared_payload_evidence = metadata_review_complete
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "asset_id": ASSET_ID,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "legal_advice": False,
        "review_basis": (
            "local_payload_files"
            if all(
                path.is_file()
                for path in (root_license, root_readme, contest_readme, contest_pdf, verify_report)
            )
            else "checked_in_intake_and_source_lock_metadata"
        ),
        "license_findings": {
            "repository_license_family": "Apache-2.0",
            "dataset_license_family": "CC-BY-4.0",
            "contest_framework_present": contest_readme.is_file() or metadata_review_complete,
            "conservative_resolution": (
                "Allow local research training and CUDA handoff with attribution and "
                "source revision preserved; keep release, model-weight release, and "
                "E1 signoff claims blocked until separate project approval and replay evidence."
            ),
        },
        "allowed_use": {
            "metadata_review": status == "TRAINING_ONLY_REVIEW_COMPLETE",
            "local_research_training": status == "TRAINING_ONLY_REVIEW_COMPLETE",
            "cuda_training_handoff": status == "TRAINING_ONLY_REVIEW_COMPLETE",
            "release_use_allowed": False,
            "commercial_use_allowed": False,
            "model_weight_release_allowed": False,
            "e1_signoff_claim_allowed": False,
            "false_claim_flags": FALSE_CLAIM_FLAGS,
        },
        "required_controls": [
            "preserve Apache-2.0 repository and CC BY 4.0 dataset attribution",
            "pin the source revision and fetch verification report in downstream manifests",
            "do not package raw FloorSet payload files in CUDA metadata payloads",
            "keep generated floorplans unreleased until deterministic E1 replay/signoff evidence exists",
        ],
        "evidence": {
            "root_license": artifact_or_declared(
                root_license,
                DECLARED_INTAKE_STATUS,
                reviewed_metadata_source,
                allow_declared=allow_declared_payload_evidence,
            ),
            "root_readme": artifact_or_declared(
                root_readme,
                DECLARED_INTAKE_STATUS,
                reviewed_metadata_source,
                allow_declared=allow_declared_payload_evidence,
            ),
            "contest_readme": artifact_or_declared(
                contest_readme,
                DECLARED_INTAKE_STATUS,
                reviewed_metadata_source,
                allow_declared=allow_declared_payload_evidence,
            ),
            "contest_spec_pdf": artifact_or_declared(
                contest_pdf,
                DECLARED_INTAKE_STATUS,
                reviewed_metadata_source,
                allow_declared=allow_declared_payload_evidence,
            ),
            "intake_manifest": artifact(intake_manifest),
            "source_lock": artifact(lockfile),
            "fetch_verification_report": artifact_or_declared(
                verify_report,
                RECORDED_INTAKE_STATUS,
                reviewed_metadata_source,
                allow_declared=allow_declared_payload_evidence,
            ),
        },
        "blockers": blockers,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "license_review.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    result = "PASS" if not blockers else "PASS_WITH_BLOCKERS"
    print(
        "STATUS: "
        f"{result} ai_eda.floorset_license_review status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
