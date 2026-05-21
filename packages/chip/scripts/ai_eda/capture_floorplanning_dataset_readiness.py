#!/usr/bin/env python3
"""Capture FloorSet/R-Zoo floorplanning dataset conversion readiness.

This is a metadata and payload-shape gate. It does not convert records, train
models, generate floorplans, or claim E1 optimization. The report defines the
minimum reproducibility evidence required before these floorplanning corpora
can feed pretraining or any E1 replay lane.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorplanning_dataset_readiness"
SCHEMA = "eliza.ai_eda.floorplanning_dataset_readiness.v1"
CLAIM_BOUNDARY = "floorplanning_dataset_readiness_only_no_conversion_training_or_e1_claim"
ASSET_IDS = ("intel-floorset", "r-zoo-rectilinear-floorplan")
R_ZOO_CONVERSION_SCHEMA = "eliza.ai_eda.r_zoo_rectilinear_floorplan_conversion_report.v1"
R_ZOO_SPLIT_SCHEMA = "eliza.ai_eda.r_zoo_rectilinear_floorplan_split_manifest.v1"
R_ZOO_LICENSE_SCHEMA = "eliza.ai_eda.r_zoo_license_review.v1"

EXPECTED_CONVERSION_PRODUCTS = {
    "intel-floorset": [
        "fixed-outline block geometry records",
        "constraint records for aspect ratio, outline, and non-overlap",
        "train/validation/test split manifest with contamination notes",
        "floorplan legality checker logs",
        "rendered floorplan image hashes for optional VLM pretraining",
    ],
    "r-zoo-rectilinear-floorplan": [
        "rectilinear polygon geometry records",
        "block adjacency and containment/overlap legality records",
        "train/validation/test split manifest with contamination notes",
        "rectilinear legality checker logs",
        "quarantined generated-floorplan candidate records",
    ],
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected YAML mapping")
    return data


def lock_entries() -> dict[str, dict[str, Any]]:
    entries = load_yaml(LOCKFILE).get("entries")
    if not isinstance(entries, list):
        raise ValueError("external/SOURCES.lock.yaml entries must be a list")
    return {
        item["id"]: item
        for item in entries
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def is_payload_sample_file(payload: Path, path: Path) -> bool:
    try:
        parts = path.relative_to(payload).parts
    except ValueError:
        return False
    if ".git" in parts:
        return False
    return not path.name.startswith("tmp_pack_")


def inspect_payload(payload: Path) -> dict[str, Any]:
    files = (
        sorted(
            path
            for path in payload.rglob("*")
            if path.is_file() and is_payload_sample_file(payload, path)
        )
        if payload.exists()
        else []
    )
    sample = files[:20]
    top_level = sorted({path.relative_to(payload).parts[0] for path in files if path != payload})
    return {
        "path": rel(payload),
        "present": payload.is_dir(),
        "file_count": len(files),
        "top_level_entries": top_level[:40],
        "sample_files": [
            {
                "path": rel(path),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in sample
        ],
    }


def parse_diearea(path: Path) -> dict[str, Any]:
    pattern = re.compile(r"\(\s*(-?\d+)\s+(-?\d+)\s*\)")
    diearea = ""
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if raw.lstrip().startswith("DIEAREA"):
                diearea = raw.strip()
                while ";" not in diearea:
                    continuation = handle.readline()
                    if not continuation:
                        break
                    diearea += " " + continuation.strip()
                break
    points = [(int(x), int(y)) for x, y in pattern.findall(diearea)]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    rectilinear = all(
        points[index][0] == points[(index + 1) % len(points)][0]
        or points[index][1] == points[(index + 1) % len(points)][1]
        for index in range(len(points))
    ) if len(points) >= 2 else False
    return {
        "path": rel(path),
        "bytes": path.stat().st_size,
        "diearea_found": bool(diearea),
        "point_count": len(points),
        "rectilinear_edges": rectilinear,
        "first_point_repeated_as_last": len(points) > 1 and points[0] == points[-1],
        "bbox": {
            "min_x": min(xs) if xs else None,
            "min_y": min(ys) if ys else None,
            "max_x": max(xs) if xs else None,
            "max_y": max(ys) if ys else None,
        },
    }


def parse_evaluation_legality(readme: Path) -> dict[str, str]:
    if not readme.is_file():
        return {}
    result: dict[str, str] = {}
    link_pattern = re.compile(r"\[([A-Za-z0-9_]+_(?:single|multi)_notch\.def)\]\([^)]*\)\s*\|\s*(Legal|Illegal)", re.IGNORECASE)
    for line in readme.read_text(encoding="utf-8", errors="replace").splitlines():
        for filename, label in link_pattern.findall(line):
            result[filename] = label.upper()
    return result


def profile_rzoo_payload(payload: Path) -> dict[str, Any]:
    if not payload.is_dir():
        return {"available": False, "reason": "payload_missing"}
    def_files = sorted(payload.rglob("*.def"))
    png_files = sorted(payload.rglob("*.png"))
    jpg_files = sorted(payload.rglob("*.jpg"))
    evaluation = sorted((payload / "for_evaluation").glob("*.def"))
    modeling = sorted((payload / "for_modeling/dataset").glob("sample_*/def_files/*.def"))
    main_dataset = sorted((payload / "dataset").glob("sample_*/def_files/*.def"))
    cv_defs = sorted((payload / "CV_application").glob("generated_defs_*/*.def"))
    legality = parse_evaluation_legality(payload / "for_evaluation/README.md")
    sample_paths = evaluation[:14]
    return {
        "available": True,
        "profile_kind": "r_zoo_rectilinear_def_payload_profile_v1",
        "def_count": len(def_files),
        "png_count": len(png_files),
        "jpg_count": len(jpg_files),
        "subsets": {
            "for_evaluation_def_count": len(evaluation),
            "for_modeling_def_count": len(modeling),
            "main_dataset_def_count": len(main_dataset),
            "cv_application_generated_def_count": len(cv_defs),
        },
        "evaluation_legality_labels": legality,
        "evaluation_legality_count": {
            "LEGAL": sum(1 for value in legality.values() if value == "LEGAL"),
            "ILLEGAL": sum(1 for value in legality.values() if value == "ILLEGAL"),
        },
        "diearea_samples": [parse_diearea(path) for path in sample_paths],
        "conversion_notes": [
            "parse DIEAREA polygons and normalize DBU coordinates",
            "pair for_modeling DEF files with aligned floorplan_plots images",
            "treat for_evaluation labels as legality-checker validation labels, not E1 optimization labels",
            "keep generated CV/application floorplans quarantined from release claims",
        ],
    }


def read_manifest(asset_id: str) -> tuple[Path, dict[str, Any] | None]:
    path = ROOT / f"external/datasets/{asset_id}/manifest.yaml"
    if not path.is_file():
        return path, None
    return path, load_yaml(path)


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON mapping")
    return data


def evidence_artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "present": path.is_file(),
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def asset_report(asset_id: str, lock: dict[str, dict[str, Any]]) -> dict[str, Any]:
    entry = lock.get(asset_id, {})
    manifest_path, manifest = read_manifest(asset_id)
    payload_path = ROOT / f"external/datasets/{asset_id}/payload"
    payload = inspect_payload(payload_path)
    schema_profile = (
        profile_rzoo_payload(payload_path)
        if asset_id == "r-zoo-rectilinear-floorplan"
        else {"available": False, "reason": "profiler_not_implemented_for_asset"}
    )
    revision = entry.get("revision") if isinstance(entry.get("revision"), dict) else {}
    validation = entry.get("validation") if isinstance(entry.get("validation"), dict) else {}
    intake = manifest.get("intake") if isinstance(manifest, dict) else {}
    blockers: list[str] = []
    if not entry:
        blockers.append("asset is missing from external/SOURCES.lock.yaml")
    if manifest is None:
        blockers.append("external intake manifest is missing")
    if revision.get("value") == "PIN_AFTER_FETCH":
        blockers.append("upstream revision must be pinned after fetch")
    if validation.get("license_review") != "complete":
        blockers.append("license review is pending")
    if validation.get("provenance_review") != "complete":
        blockers.append("provenance review is pending")
    if validation.get("hash_verification") != "complete":
        blockers.append("payload hash verification is pending")
    if intake.get("release_use_allowed") is not False:
        blockers.append("intake manifest must keep release_use_allowed=false")
    if not payload["present"]:
        blockers.append("local payload is not present under the ignored payload directory")
    elif payload["file_count"] <= 0:
        blockers.append("local payload directory is present but empty")
    conversion_evidence: dict[str, Any] = {"available": False}
    split_evidence: dict[str, Any] = {"available": False}
    license_evidence: dict[str, Any] = {"available": False}
    if asset_id == "r-zoo-rectilinear-floorplan":
        run_id = getattr(asset_report, "run_id", "validation")
        conversion_path = ROOT / f"build/ai_eda/r_zoo_rectilinear_floorplan/{run_id}/conversion_report.json"
        split_path = ROOT / f"build/ai_eda/r_zoo_rectilinear_floorplan_splits/{run_id}/split_manifest.json"
        license_path = ROOT / f"build/ai_eda/r_zoo_license_review/{run_id}/license_review.json"
        conversion = load_json(conversion_path)
        split = load_json(split_path)
        license_review = load_json(license_path)
        conversion_ok = bool(
            conversion
            and conversion.get("schema") == R_ZOO_CONVERSION_SCHEMA
            and conversion.get("converted_case_count") == 14
            and conversion.get("converted_record_count") == 42
        )
        split_ok = bool(
            split
            and split.get("schema") == R_ZOO_SPLIT_SCHEMA
            and split.get("training_use_allowed") is True
            and split.get("contamination_review", {}).get("status") == "PASS"
        )
        license_ok = bool(
            license_review
            and license_review.get("schema") == R_ZOO_LICENSE_SCHEMA
            and license_review.get("status") == "TRAINING_ONLY_REVIEW_COMPLETE"
            and license_review.get("allowed_use", {}).get("cuda_training_handoff") is True
            and license_review.get("allowed_use", {}).get("release_use_allowed") is False
        )
        conversion_evidence = {
            "available": conversion_ok,
            "artifact": evidence_artifact(conversion_path),
            "case_count": conversion.get("converted_case_count") if conversion else None,
            "record_count": conversion.get("converted_record_count") if conversion else None,
        }
        split_evidence = {
            "available": split_ok,
            "artifact": evidence_artifact(split_path),
            "summary": split.get("summary") if split else None,
        }
        license_evidence = {
            "available": license_ok,
            "artifact": evidence_artifact(license_path),
            "status": license_review.get("status") if license_review else None,
            "release_use_allowed": license_review.get("allowed_use", {}).get("release_use_allowed")
            if license_review
            else None,
            "commercial_use_allowed": license_review.get("allowed_use", {}).get("commercial_use_allowed")
            if license_review
            else None,
        }
        if license_ok:
            blockers = [item for item in blockers if item != "license review is pending"]
        if not conversion_ok:
            blockers.append("dataset-specific schema converter is not implemented")
            blockers.append("floorplan legality checker logs are not present")
        if not split_ok:
            blockers.append("split manifest and benchmark contamination review are not present")
        if not license_ok:
            blockers.append("R-Zoo training-only license review evidence is missing")
    else:
        blockers.extend(
            [
                "dataset-specific schema converter is not implemented",
                "floorplan legality checker logs are not present",
                "split manifest and benchmark contamination review are not present",
            ]
        )
    blockers.append(
        "generated floorplans must remain quarantined until deterministic E1 replay/signoff evidence exists"
    )
    status = "READY_FOR_SCHEMA_PROFILING" if payload["present"] and payload["file_count"] else "BLOCKED_NO_PAYLOAD"
    return {
        "asset_id": asset_id,
        "source_url": entry.get("source_url"),
        "lock_entry_present": bool(entry),
        "manifest": {
            "path": rel(manifest_path),
            "present": manifest is not None,
            "review_status": intake.get("review_status") if isinstance(intake, dict) else None,
            "release_use_allowed": False,
        },
        "revision": revision,
        "payload": payload,
        "schema_profile": schema_profile,
        "conversion_evidence": conversion_evidence,
        "split_evidence": split_evidence,
        "license_evidence": license_evidence,
        "status": status,
        "expected_conversion_products": EXPECTED_CONVERSION_PRODUCTS[asset_id],
        "required_training_gates": [
            "pin upstream revision and payload hashes",
            "complete license and provenance review",
            "implement dataset-specific geometry parser and schema converter",
            "validate floorplan legality, dimensions, non-overlap, and constraint consistency",
            "write split manifest and contamination review",
            "feed records only into training-only corpora until E1 replay/signoff gates pass",
        ],
        "blockers": blockers,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    setattr(asset_report, "run_id", args.run_id)
    lock = lock_entries()
    assets = [asset_report(asset_id, lock) for asset_id in ASSET_IDS]
    blockers = [
        f"{asset['asset_id']}: {blocker}"
        for asset in assets
        for blocker in asset["blockers"]
    ]
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "asset_ids": list(ASSET_IDS),
        "asset_count": len(assets),
        "release_use_allowed": False,
        "conversion_claim_allowed": False,
        "training_claim_allowed": False,
        "e1_optimization_claim_allowed": False,
        "status": "BLOCKED_WITH_READINESS_CONTRACT" if blockers else "READY_FOR_CONVERSION",
        "assets": assets,
        "blockers": blockers,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "floorplanning_dataset_readiness.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.floorplanning_dataset_readiness "
        f"status={report['status']} assets={len(assets)} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
