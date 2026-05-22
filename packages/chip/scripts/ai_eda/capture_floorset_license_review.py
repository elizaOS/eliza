#!/usr/bin/env python3
"""Capture a conservative FloorSet license/provenance review."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorset_license_review"
SCHEMA = "eliza.ai_eda.floorset_license_review.v1"
CLAIM_BOUNDARY = "floorset_license_review_training_only_no_release_or_legal_advice_claim"
ASSET_ID = "intel-floorset"


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


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


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

    license_text = read_text(root_license)
    readme_text = read_text(root_readme)
    contest_text = read_text(contest_readme)
    blockers: list[str] = []
    if "Apache License" not in license_text:
        blockers.append("root LICENSE does not identify Apache-2.0")
    if "Creative Commons Attribution 4.0 International License" not in readme_text:
        blockers.append("README does not identify dataset CC BY 4.0 terms")
    if "ICCAD 2026" not in contest_text:
        blockers.append("contest README evidence is missing ICCAD 2026 context")
    for path, label in (
        (intake_manifest, "external intake manifest"),
        (lockfile, "external source lock"),
        (verify_report, "fetch verification report"),
    ):
        if not path.is_file():
            blockers.append(f"{label} is missing")

    status = "TRAINING_ONLY_REVIEW_COMPLETE" if not blockers else "REVIEW_INCOMPLETE"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "asset_id": ASSET_ID,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "legal_advice": False,
        "license_findings": {
            "repository_license_family": "Apache-2.0",
            "dataset_license_family": "CC-BY-4.0",
            "contest_framework_present": contest_readme.is_file(),
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
        },
        "required_controls": [
            "preserve Apache-2.0 repository and CC BY 4.0 dataset attribution",
            "pin the source revision and fetch verification report in downstream manifests",
            "do not package raw FloorSet payload files in CUDA metadata payloads",
            "keep generated floorplans unreleased until deterministic E1 replay/signoff evidence exists",
        ],
        "evidence": {
            "root_license": artifact(root_license),
            "root_readme": artifact(root_readme),
            "contest_readme": artifact(contest_readme),
            "contest_spec_pdf": artifact(contest_pdf),
            "intake_manifest": artifact(intake_manifest),
            "source_lock": artifact(lockfile),
            "fetch_verification_report": artifact(verify_report),
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
