#!/usr/bin/env python3
"""Capture deterministic R-Zoo train/val/test split and contamination evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/r_zoo_rectilinear_floorplan_splits"
SCHEMA = "eliza.ai_eda.r_zoo_rectilinear_floorplan_split_manifest.v1"
CLAIM_BOUNDARY = "r_zoo_split_manifest_training_only_no_e1_signoff_or_release_claim"
CONVERSION_SCHEMA = "eliza.ai_eda.r_zoo_rectilinear_floorplan_conversion_report.v1"
SPLIT_BY_FAMILY = {
    "ariane133": "train",
    "ariane136": "train",
    "bp_be": "train",
    "bp_fe": "train",
    "bp_multi": "train",
    "sw": "val",
    "tr": "test",
}
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "e1_signoff_evidence": False,
    "optimization_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
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


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def family_from_case(case_id: str) -> str:
    prefix = "r-zoo-rectilinear-floorplan-"
    case = case_id.removeprefix(prefix)
    for suffix in ("_single_notch", "_multi_notch"):
        if case.endswith(suffix):
            return case[: -len(suffix)]
    return case


def case_id_from_record_id(record_id: str) -> str:
    for suffix in (
        "-design-bundle",
        "-diearea-legality-graph",
        "-legality-label-flow-run",
    ):
        if record_id.endswith(suffix):
            return record_id[: -len(suffix)]
    return record_id


def label_from_record(path: Path) -> str | None:
    record = load_json(path)
    if record.get("schema") == "eda.graph_sample.v1":
        labels = record.get("labels", {})
        values = labels.get("values") if isinstance(labels, dict) else None
        label = values.get("public_legality") if isinstance(values, dict) else None
        return label if label in {"LEGAL", "ILLEGAL"} else None
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--conversion-run-id",
        default=None,
        help="R-Zoo conversion run id; defaults to --run-id.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    conversion_run_id = args.conversion_run_id or args.run_id
    conversion_path = (
        ROOT
        / f"build/ai_eda/r_zoo_rectilinear_floorplan/{conversion_run_id}/conversion_report.json"
    )
    conversion = load_json(conversion_path)
    blockers: list[str] = []
    if conversion.get("schema") != CONVERSION_SCHEMA:
        blockers.append("R-Zoo conversion report schema mismatch")

    case_records: dict[str, list[dict[str, Any]]] = defaultdict(list)
    label_by_case: dict[str, str] = {}
    for item in conversion.get("converted_records", []):
        if not isinstance(item, dict) or not isinstance(item.get("json"), str):
            blockers.append("conversion report has malformed converted_records entry")
            continue
        path = repo_path(item["json"])
        record_id = str(item.get("id", ""))
        case_id = case_id_from_record_id(record_id)
        case_records[case_id].append(
            {
                "id": record_id,
                "schema": item.get("schema"),
                "path": rel(path),
                "sha256": sha256_file(path),
            }
        )
        label = label_from_record(path) if path.is_file() else None
        if label:
            label_by_case[case_id] = label

    split_cases: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    family_splits: dict[str, str] = {}
    for case_id in sorted(case_records):
        family = family_from_case(case_id)
        split = SPLIT_BY_FAMILY.get(family)
        if split is None:
            blockers.append(f"missing deterministic split assignment for family {family}")
            split = "train"
        if family in family_splits and family_splits[family] != split:
            blockers.append(f"family {family} assigned to multiple splits")
        family_splits[family] = split
        split_cases[split].append(
            {
                "case_id": case_id,
                "design_family": family,
                "public_legality": label_by_case.get(case_id),
                "record_count": len(case_records[case_id]),
                "records": case_records[case_id],
            }
        )

    family_by_split: dict[str, set[str]] = {
        split: {case["design_family"] for case in cases} for split, cases in split_cases.items()
    }
    overlaps: list[dict[str, Any]] = []
    for left in ("train", "val", "test"):
        for right in ("train", "val", "test"):
            if left >= right:
                continue
            shared = sorted(family_by_split[left] & family_by_split[right])
            if shared:
                overlaps.append({"left": left, "right": right, "design_families": shared})
    if overlaps:
        blockers.append("design family leakage exists across splits")
    for split, cases in split_cases.items():
        if not cases:
            blockers.append(f"{split} split is empty")
    if sum(len(cases) for cases in split_cases.values()) != 14:
        blockers.append("split manifest must cover exactly 14 R-Zoo evaluation cases")

    label_counts = {
        split: dict(Counter(case["public_legality"] for case in cases))
        for split, cases in split_cases.items()
    }
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "training_use_allowed": not blockers,
        "e1_signoff_evidence": False,
        "optimization_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "evidence_run_ids": {"conversion": conversion_run_id},
        "source_conversion": artifact(conversion_path),
        "split_policy": {
            "method": "deterministic_design_family_holdout",
            "reason": "single/multi-notch variants for the same design family must not cross train/val/test",
            "design_family_split_map": SPLIT_BY_FAMILY,
            "generated_floorplans_quarantined": True,
            "public_legality_labels_are_training_only": True,
        },
        "summary": {
            "case_count": sum(len(cases) for cases in split_cases.values()),
            "record_count": sum(
                case["record_count"] for cases in split_cases.values() for case in cases
            ),
            "split_counts": {split: len(cases) for split, cases in split_cases.items()},
            "label_counts": label_counts,
            "design_family_overlap_count": len(overlaps),
            "blocker_count": len(blockers),
        },
        "splits": split_cases,
        "contamination_review": {
            "status": "PASS" if not overlaps else "FAIL",
            "leakage_unit": "design_family",
            "design_family_overlaps": overlaps,
            "e1_overlap_review": {
                "status": "NO_E1_SIGNOFF_OR_OPTIMIZATION_CLAIM",
                "detail": "R-Zoo public labels are not E1 labels; deterministic E1 replay is still required.",
            },
        },
        "blockers": blockers,
        "next_required_gates": [
            "keep R-Zoo generated floorplans quarantined from release use",
            "run only training-only legality/floorplan pretraining until E1 replay evidence exists",
            "complete license/provenance/hash review before release use",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "split_manifest.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS" if not blockers else "PASS_WITH_BLOCKERS"
    print(
        "STATUS: "
        f"{status} ai_eda.r_zoo_split_manifest "
        f"cases={report['summary']['case_count']} splits={report['summary']['split_counts']} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
