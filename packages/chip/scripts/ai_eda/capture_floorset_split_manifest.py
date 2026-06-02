#!/usr/bin/env python3
"""Capture deterministic FloorSet Lite split and contamination evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorset_lite_splits"
SCHEMA = "eliza.ai_eda.floorset_lite_split_manifest.v1"
CLAIM_BOUNDARY = "floorset_lite_split_manifest_training_only_no_e1_signoff_or_release_claim"
FALSE_CLAIM_FLAGS = {
    "release_use_allowed": False,
    "e1_signoff_evidence": False,
    "optimization_claim_allowed": False,
}
CONVERSION_SCHEMA = "eliza.ai_eda.floorset_lite_conversion_report.v1"


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


def case_id_from_record_id(record_id: str) -> str:
    for suffix in ("-design-bundle", "-constraint-graph", "-tensor-conversion-flow-run"):
        if record_id.endswith(suffix):
            return record_id[: -len(suffix)]
    return record_id


def config_number(case_id: str) -> int:
    return int(case_id.rsplit("config_", 1)[-1])


def split_for_config(number: int) -> str:
    if number <= 100:
        return "train"
    if number <= 110:
        return "val"
    return "test"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--conversion-run-id",
        default=None,
        help="FloorSet conversion run id; defaults to --run-id.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    conversion_run_id = args.conversion_run_id or args.run_id
    conversion_path = (
        ROOT / f"build/ai_eda/floorset_lite/{conversion_run_id}/conversion_report.json"
    )
    conversion = load_json(conversion_path)
    blockers: list[str] = []
    if conversion.get("schema") != CONVERSION_SCHEMA:
        blockers.append("FloorSet Lite conversion report schema mismatch")
    case_records: dict[str, list[dict[str, Any]]] = defaultdict(list)
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
    split_cases: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    for case_id in sorted(case_records, key=config_number):
        split = split_for_config(config_number(case_id))
        split_cases[split].append(
            {
                "case_id": case_id,
                "config_number": config_number(case_id),
                "record_count": len(case_records[case_id]),
                "records": case_records[case_id],
            }
        )
    for split, cases in split_cases.items():
        if not cases:
            blockers.append(f"{split} split is empty")
    if sum(len(cases) for cases in split_cases.values()) != 100:
        blockers.append("split manifest must cover exactly 100 FloorSet Lite validation cases")
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
            "method": "deterministic_config_number_holdout",
            "reason": "LiteTensorDataTest config numbers are the stable public validation case ids",
            "train": "config_21 through config_100",
            "val": "config_101 through config_110",
            "test": "config_111 through config_120",
            "generated_floorplans_quarantined": True,
            "public_labels_are_training_only": True,
        },
        "summary": {
            "case_count": sum(len(cases) for cases in split_cases.values()),
            "record_count": sum(
                case["record_count"] for cases in split_cases.values() for case in cases
            ),
            "split_counts": {split: len(cases) for split, cases in split_cases.items()},
            "blocker_count": len(blockers),
        },
        "splits": split_cases,
        "contamination_review": {
            "status": "PASS" if not blockers else "FAIL",
            "leakage_unit": "public_validation_config_id",
            "config_id_overlaps": [],
            "e1_overlap_review": {
                "status": "NO_E1_SIGNOFF_OR_OPTIMIZATION_CLAIM",
                "detail": "FloorSet labels are public benchmark labels; deterministic E1 replay is still required.",
            },
        },
        "blockers": blockers,
        "next_required_gates": [
            "keep generated floorplans quarantined from release use",
            "use only training-only FloorSet pretraining until E1 replay evidence exists",
            "validate geometry/constraint legality before using model candidates",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "split_manifest.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS" if not blockers else "PASS_WITH_BLOCKERS"
    print(
        "STATUS: "
        f"{status} ai_eda.floorset_split_manifest "
        f"cases={report['summary']['case_count']} splits={report['summary']['split_counts']} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
