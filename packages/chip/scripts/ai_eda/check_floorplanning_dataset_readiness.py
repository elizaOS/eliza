#!/usr/bin/env python3
"""Validate FloorSet/R-Zoo floorplanning dataset readiness reports."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT
    / "build/ai_eda/floorplanning_dataset_readiness/validation/floorplanning_dataset_readiness.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.floorplanning_dataset_readiness.v1"
EXPECTED_CLAIM_BOUNDARY = "floorplanning_dataset_readiness_only_no_conversion_training_or_e1_claim"
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "conversion_claim_allowed": False,
    "training_claim_allowed": False,
    "e1_optimization_claim_allowed": False,
}
REQUIRED_ASSETS = {"intel-floorset", "r-zoo-rectilinear-floorplan"}
REQUIRED_BLOCKER_FRAGMENTS = {
    "dataset-specific schema converter evidence is absent",
    "split manifest and benchmark contamination review are not present",
    "generated floorplans must remain quarantined",
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


def validate_payload(asset_id: str, payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return [f"{asset_id}: payload must be a mapping"]
    errors: list[str] = []
    path_value = payload.get("path")
    if not isinstance(path_value, str) or not path_value.endswith("/payload"):
        errors.append(f"{asset_id}: payload.path must point to ignored payload directory")
    present = payload.get("present")
    file_count = payload.get("file_count")
    if not isinstance(present, bool):
        errors.append(f"{asset_id}: payload.present must be boolean")
    if not isinstance(file_count, int) or file_count < 0:
        errors.append(f"{asset_id}: payload.file_count must be non-negative integer")
    for index, sample in enumerate(payload.get("sample_files", [])):
        if not isinstance(sample, dict):
            errors.append(f"{asset_id}: sample_files[{index}] must be mapping")
            continue
        sample_path = sample.get("path")
        digest = sample.get("sha256")
        if not isinstance(sample_path, str) or not isinstance(digest, str):
            errors.append(f"{asset_id}: sample_files[{index}] missing path or digest")
            continue
        path = repo_path(sample_path)
        if not path.is_file():
            errors.append(f"{asset_id}: sample file missing: {sample_path}")
        elif sha256_file(path) != digest:
            errors.append(f"{asset_id}: stale sample digest: {sample_path}")
    return errors


def validate_evidence_artifact(asset_id: str, artifact: Any, label: str) -> list[str]:
    if not isinstance(artifact, dict):
        return [f"{asset_id}: {label} must be a mapping"]
    errors: list[str] = []
    path_value = artifact.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{asset_id}: {label}.path must be present")
    elif artifact.get("present") is True:
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{asset_id}: {label} missing on disk")
        elif artifact.get("sha256") != sha256_file(path):
            errors.append(f"{asset_id}: {label}.sha256 is stale")
    elif artifact.get("present") is not False:
        errors.append(f"{asset_id}: {label}.present must be boolean")
    return errors


def validate_asset(asset: Any) -> list[str]:
    if not isinstance(asset, dict):
        return ["asset entry must be a mapping"]
    asset_id = asset.get("asset_id")
    errors: list[str] = []
    if asset_id not in REQUIRED_ASSETS:
        errors.append(f"unexpected asset_id {asset_id!r}")
        asset_id = str(asset_id)
    if asset.get("lock_entry_present") is not True:
        errors.append(f"{asset_id}: lock entry must be present")
    manifest = asset.get("manifest")
    if not isinstance(manifest, dict) or manifest.get("present") is not True:
        errors.append(f"{asset_id}: intake manifest must be present")
    elif manifest.get("release_use_allowed") is not False:
        errors.append(f"{asset_id}: release_use_allowed must be false")
    if asset.get("status") not in {"BLOCKED_NO_PAYLOAD", "READY_FOR_SCHEMA_PROFILING"}:
        errors.append(f"{asset_id}: invalid status")
    products = asset.get("expected_conversion_products")
    gates = asset.get("required_training_gates")
    if not isinstance(products, list) or len(products) < 4:
        errors.append(f"{asset_id}: expected_conversion_products must be concrete")
    if not isinstance(gates, list) or len(gates) < 5:
        errors.append(f"{asset_id}: required_training_gates must be concrete")
    profile = asset.get("schema_profile")
    if not isinstance(profile, dict):
        errors.append(f"{asset_id}: schema_profile must be a mapping")
    elif asset_id == "r-zoo-rectilinear-floorplan" and asset.get("payload", {}).get("present"):
        if profile.get("available") is not True:
            errors.append(f"{asset_id}: fetched payload must have a schema profile")
        if profile.get("def_count", 0) < 14:
            errors.append(f"{asset_id}: schema profile must count fetched DEF files")
        subsets = profile.get("subsets")
        if not isinstance(subsets, dict) or subsets.get("for_evaluation_def_count") != 14:
            errors.append(f"{asset_id}: schema profile must identify 14 evaluation DEFs")
        labels = profile.get("evaluation_legality_count")
        if not isinstance(labels, dict) or labels.get("LEGAL") != 11 or labels.get("ILLEGAL") != 3:
            errors.append(f"{asset_id}: evaluation legality labels must match 11 legal / 3 illegal")
        samples = profile.get("diearea_samples")
        if not isinstance(samples, list) or len(samples) != 14:
            errors.append(f"{asset_id}: schema profile must sample all evaluation DEF DIEAREAs")
        else:
            for index, sample in enumerate(samples):
                if not isinstance(sample, dict):
                    errors.append(f"{asset_id}: diearea_samples[{index}] must be mapping")
                    continue
                if sample.get("diearea_found") is not True:
                    errors.append(f"{asset_id}: diearea_samples[{index}] missing DIEAREA")
                if sample.get("rectilinear_edges") is not True:
                    errors.append(f"{asset_id}: diearea_samples[{index}] must be rectilinear")
    elif asset_id == "intel-floorset" and asset.get("payload", {}).get("present"):
        if profile.get("available") is not True:
            errors.append(f"{asset_id}: fetched payload must have a schema profile")
        if profile.get("lite_validation_config_count") != 100:
            errors.append(
                f"{asset_id}: schema profile must identify 100 LiteTensorDataTest configs"
            )
        if profile.get("lite_validation_data_file_count") != 100:
            errors.append(f"{asset_id}: schema profile must identify 100 validation data tensors")
        if profile.get("lite_validation_label_file_count") != 100:
            errors.append(f"{asset_id}: schema profile must identify 100 validation label tensors")
        if profile.get("contest_framework_present") is not True:
            errors.append(f"{asset_id}: contest framework must be present")
        contest_files = profile.get("contest_files")
        if not isinstance(contest_files, dict) or not all(contest_files.values()):
            errors.append(f"{asset_id}: contest framework file inventory is incomplete")
        hf_profile = profile.get("hf_archive_payload")
        if not isinstance(hf_profile, dict):
            errors.append(f"{asset_id}: HF archive payload profile is missing")
        elif hf_profile.get("archive_like_file_count", 0) < 7:
            errors.append(f"{asset_id}: HF archive payload profile must identify local archives")
    blockers = asset.get("blockers")
    if not isinstance(blockers, list) or not blockers:
        errors.append(f"{asset_id}: blockers must be non-empty until conversion exists")
    else:
        text = "\n".join(str(item) for item in blockers)
        required_fragments = set(REQUIRED_BLOCKER_FRAGMENTS)
        if asset_id == "r-zoo-rectilinear-floorplan":
            conversion = asset.get("conversion_evidence")
            split = asset.get("split_evidence")
            license_evidence = asset.get("license_evidence")
            if not isinstance(conversion, dict):
                errors.append(f"{asset_id}: conversion_evidence must be a mapping")
            elif conversion.get("available") is True:
                if conversion.get("case_count") != 14 or conversion.get("record_count") != 42:
                    errors.append(
                        f"{asset_id}: conversion evidence must cover 14 cases / 42 records"
                    )
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, conversion.get("artifact"), "conversion_evidence.artifact"
                    )
                )
                required_fragments.discard("dataset-specific schema converter evidence is absent")
            if not isinstance(split, dict):
                errors.append(f"{asset_id}: split_evidence must be a mapping")
            elif split.get("available") is True:
                summary = split.get("summary")
                if not isinstance(summary, dict) or summary.get("case_count") != 14:
                    errors.append(f"{asset_id}: split evidence must summarize 14 cases")
                if isinstance(summary, dict) and summary.get("design_family_overlap_count") != 0:
                    errors.append(f"{asset_id}: split evidence must have no family overlap")
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, split.get("artifact"), "split_evidence.artifact"
                    )
                )
                required_fragments.discard(
                    "split manifest and benchmark contamination review are not present"
                )
                required_fragments.discard("floorplan legality checker logs are not present")
            if not isinstance(license_evidence, dict):
                errors.append(f"{asset_id}: license_evidence must be a mapping")
            elif license_evidence.get("available") is True:
                if license_evidence.get("status") != "TRAINING_ONLY_REVIEW_COMPLETE":
                    errors.append(f"{asset_id}: license evidence must be training-only complete")
                if license_evidence.get("release_use_allowed") is not False:
                    errors.append(
                        f"{asset_id}: license evidence must keep release_use_allowed=false"
                    )
                if license_evidence.get("commercial_use_allowed") is not False:
                    errors.append(
                        f"{asset_id}: license evidence must keep commercial_use_allowed=false"
                    )
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, license_evidence.get("artifact"), "license_evidence.artifact"
                    )
                )
        elif asset_id == "intel-floorset":
            conversion = asset.get("conversion_evidence")
            split = asset.get("split_evidence")
            license_evidence = asset.get("license_evidence")
            hf_archive_evidence = asset.get("hf_archive_evidence")
            if isinstance(conversion, dict) and conversion.get("available") is True:
                if conversion.get("case_count") != 100 or conversion.get("record_count") != 300:
                    errors.append(
                        f"{asset_id}: conversion evidence must cover 100 cases / 300 records"
                    )
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, conversion.get("artifact"), "conversion_evidence.artifact"
                    )
                )
                required_fragments.discard("dataset-specific schema converter evidence is absent")
                required_fragments.discard("floorplan legality checker logs are not present")
            elif not isinstance(conversion, dict):
                errors.append(f"{asset_id}: conversion_evidence must be a mapping")
            if isinstance(split, dict) and split.get("available") is True:
                summary = split.get("summary")
                if not isinstance(summary, dict) or summary.get("case_count") != 100:
                    errors.append(f"{asset_id}: split evidence must summarize 100 cases")
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, split.get("artifact"), "split_evidence.artifact"
                    )
                )
                required_fragments.discard(
                    "split manifest and benchmark contamination review are not present"
                )
            elif not isinstance(split, dict):
                errors.append(f"{asset_id}: split_evidence must be a mapping")
            if (
                not isinstance(license_evidence, dict)
                or license_evidence.get("available") is not True
            ):
                errors.append(f"{asset_id}: license_evidence.available must be true")
            else:
                if license_evidence.get("status") != "TRAINING_ONLY_REVIEW_COMPLETE":
                    errors.append(f"{asset_id}: license evidence must be training-only complete")
                if license_evidence.get("release_use_allowed") is not False:
                    errors.append(
                        f"{asset_id}: license evidence must keep release_use_allowed=false"
                    )
                if license_evidence.get("commercial_use_allowed") is not False:
                    errors.append(
                        f"{asset_id}: license evidence must keep commercial_use_allowed=false"
                    )
                errors.extend(
                    validate_evidence_artifact(
                        asset_id, license_evidence.get("artifact"), "license_evidence.artifact"
                    )
                )
            if (
                not isinstance(hf_archive_evidence, dict)
                or hf_archive_evidence.get("available") is not True
            ):
                errors.append(f"{asset_id}: hf_archive_evidence.available must be true")
            else:
                if hf_archive_evidence.get("status") != "VERIFIED_FULL_HF_ARCHIVE_SET":
                    errors.append(f"{asset_id}: HF archive evidence must be fully verified")
                if hf_archive_evidence.get("verified_archive_count") != 10:
                    errors.append(f"{asset_id}: HF archive evidence must cover 10 files")
                if hf_archive_evidence.get("verified_total_bytes") != 29665773263:
                    errors.append(f"{asset_id}: HF archive byte total mismatch")
                errors.extend(
                    validate_evidence_artifact(
                        asset_id,
                        hf_archive_evidence.get("artifact"),
                        "hf_archive_evidence.artifact",
                    )
                )
        for fragment in required_fragments:
            if fragment not in text:
                errors.append(f"{asset_id}: missing blocker fragment {fragment!r}")
    errors.extend(validate_payload(asset_id, asset.get("payload")))
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    for field in (
        "release_use_allowed",
        "conversion_claim_allowed",
        "training_claim_allowed",
        "e1_optimization_claim_allowed",
    ):
        if report.get(field) is not False:
            errors.append(f"{field} must be false")
    if report.get("false_claim_flags") != FALSE_CLAIM_FLAGS:
        errors.append("false_claim_flags must match denied floorplanning readiness claims")
    if set(report.get("asset_ids", [])) != REQUIRED_ASSETS:
        errors.append("asset_ids mismatch")
    assets = report.get("assets")
    if not isinstance(assets, list):
        return errors + ["assets must be a list"]
    if report.get("asset_count") != len(assets):
        errors.append("asset_count mismatch")
    seen = {asset.get("asset_id") for asset in assets if isinstance(asset, dict)}
    if seen != REQUIRED_ASSETS:
        errors.append("assets must contain exactly FloorSet and R-Zoo")
    for asset in assets:
        errors.extend(validate_asset(asset))
    blockers = report.get("blockers")
    if report.get("status") != "BLOCKED_WITH_READINESS_CONTRACT":
        errors.append("status must remain blocked until conversion evidence exists")
    if not isinstance(blockers, list) or len(blockers) < len(REQUIRED_ASSETS):
        errors.append("report blockers must summarize asset blockers")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(
            f"STATUS: FAIL ai_eda.floorplanning_dataset_readiness missing_report {rel(args.report)}"
        )
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.floorplanning_dataset_readiness {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.floorplanning_dataset_readiness {error}")
        return 1
    print(
        "STATUS: PASS_BLOCKED ai_eda.floorplanning_dataset_readiness "
        f"assets={report['asset_count']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
