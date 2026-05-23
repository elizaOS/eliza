#!/usr/bin/env python3
"""Capture a conservative R-Zoo license/provenance review."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/r_zoo_license_review"
SCHEMA = "eliza.ai_eda.r_zoo_license_review.v1"
CLAIM_BOUNDARY = "r_zoo_license_review_training_only_no_release_or_legal_advice_claim"
ASSET_ID = "r-zoo-rectilinear-floorplan"


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
    payload = ROOT / "external/datasets/r-zoo-rectilinear-floorplan/payload"
    intake_manifest = ROOT / "external/datasets/r-zoo-rectilinear-floorplan/manifest.yaml"
    lockfile = ROOT / "external/SOURCES.lock.yaml"
    root_license = payload / "LICENSE"
    root_readme = payload / "README.md"
    modeling_readme = payload / "for_modeling/README.md"
    evaluation_readme = payload / "for_evaluation/README.md"

    root_license_text = read_text(root_license)
    modeling_text = read_text(modeling_readme)
    blockers: list[str] = []
    if "Creative Commons Attribution-NonCommercial 4.0" not in root_license_text:
        blockers.append("root LICENSE does not identify CC BY-NC 4.0")
    if "MIT License" not in modeling_text:
        blockers.append("for_modeling README conflict note was not found")
    if not intake_manifest.is_file():
        blockers.append("external intake manifest is missing")
    if not lockfile.is_file():
        blockers.append("external source lock is missing")

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
            "root_license_family": "CC-BY-NC-4.0",
            "root_license_noncommercial": True,
            "subset_conflict_note_present": "MIT License" in modeling_text,
            "conservative_resolution": (
                "Treat the complete R-Zoo payload as CC-BY-NC-4.0 / non-commercial; "
                "do not rely on the subset MIT note for release or commercial use."
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
            "preserve attribution and source revision in downstream manifests",
            "do not package raw payload files in CUDA metadata payloads",
            "keep model weights and generated floorplans unreleased until separate legal approval",
            "require deterministic E1 replay/signoff before optimization claims",
        ],
        "evidence": {
            "root_license": artifact(root_license),
            "root_readme": artifact(root_readme),
            "modeling_readme": artifact(modeling_readme),
            "evaluation_readme": artifact(evaluation_readme),
            "intake_manifest": artifact(intake_manifest),
            "source_lock": artifact(lockfile),
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
        f"{result} ai_eda.r_zoo_license_review status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
