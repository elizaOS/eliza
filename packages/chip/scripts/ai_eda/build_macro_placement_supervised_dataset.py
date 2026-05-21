#!/usr/bin/env python3
"""Build supervised macro-placement JSONL datasets from normalized cases.

This prepares CUDA-host training inputs without running training or claiming
physical-design quality. Labels are target placements already present in
normalized `eda.placement_case.v1` records. Samples with missing macro sizes use
the same 1 um fallback as the deterministic proxy baselines and carry an
explicit size_status field for downstream filtering.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIRS = (
    ROOT / "build/ai_eda/internal_dataset_fixtures/validation/records",
    ROOT / "build/ai_eda/tilos_macroplacement/validation/records",
    ROOT / "build/ai_eda/chipbench_d/validation/records",
    ROOT / "build/ai_eda/e1_softmacro_cases/validation/records",
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_supervised_dataset"
CLAIM_BOUNDARY = (
    "macro_placement_supervised_dataset_only_no_training_inference_ppa_or_release_claim"
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_record(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def placement_records(record_dirs: list[Path]) -> list[tuple[Path, dict[str, Any]]]:
    records: list[tuple[Path, dict[str, Any]]] = []
    for directory in record_dirs:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.json")) + sorted(directory.glob("*.yaml")):
            record = load_record(path)
            if record.get("schema") == "eda.placement_case.v1":
                records.append((path, record))
    return records


def split_case_groups(case_ids: list[str]) -> dict[str, str]:
    ordered = sorted(case_ids, key=lambda item: hashlib.sha256(item.encode("utf-8")).hexdigest())
    count = len(ordered)
    if count == 0:
        return {}
    test_count = max(1, round(count * 0.1)) if count >= 3 else 0
    val_count = max(1, round(count * 0.1)) if count >= 2 else 0
    train_count = max(count - val_count - test_count, 0)
    splits: dict[str, str] = {}
    for index, case_id in enumerate(ordered):
        if index < train_count:
            splits[case_id] = "train"
        elif index < train_count + val_count:
            splits[case_id] = "val"
        else:
            splits[case_id] = "test"
    return splits


def object_size(obj: dict[str, Any]) -> tuple[float, float, str]:
    width = obj.get("width_um")
    height = obj.get("height_um")
    if width is None or height is None:
        return (
            float(width if width is not None else 1.0),
            float(height if height is not None else 1.0),
            "fallback_missing_lef_size",
        )
    return float(width), float(height), "source_lef_size"


def safe_ratio(value: float, denominator: float) -> float | None:
    if denominator <= 0.0:
        return None
    return round(value / denominator, 8)


def sample_for_object(
    path: Path,
    case: dict[str, Any],
    obj: dict[str, Any],
    object_index: int,
) -> dict[str, Any] | None:
    target = obj.get("target_placement")
    if not isinstance(target, dict) or "x_um" not in target or "y_um" not in target:
        return None
    core = [float(value) for value in case["floorplan"]["core_area_um"]]
    die = [float(value) for value in case["floorplan"]["die_area_um"]]
    core_w = core[2] - core[0]
    core_h = core[3] - core[1]
    die_w = die[2] - die[0]
    die_h = die[3] - die[1]
    width, height, size_status = object_size(obj)
    x_um = float(target["x_um"])
    y_um = float(target["y_um"])
    case_id = str(case["id"])
    object_id = str(obj["id"])
    return {
        "schema": "eliza.ai_eda.macro_placement_supervised_sample.v1",
        "id": hashlib.sha256(f"{case_id}:{object_id}".encode()).hexdigest()[:24],
        "source_record": rel(path),
        "case_id": case_id,
        "design_bundle_id": case["design_bundle_id"],
        "object": {
            "id": object_id,
            "index": object_index,
            "macro_name": obj.get("macro_name"),
            "type": obj.get("type", "hard_macro"),
            "width_um": width,
            "height_um": height,
            "size_status": size_status,
            "width_over_core": safe_ratio(width, core_w),
            "height_over_core": safe_ratio(height, core_h),
        },
        "floorplan": {
            "die_area_um": die,
            "core_area_um": core,
            "core_width_um": core_w,
            "core_height_um": core_h,
            "die_width_um": die_w,
            "die_height_um": die_h,
        },
        "label": {
            "x_um": x_um,
            "y_um": y_um,
            "orientation": target.get("orientation", "N"),
            "x_over_core": safe_ratio(x_um - core[0], core_w),
            "y_over_core": safe_ratio(y_um - core[1], core_h),
            "source": target.get("source"),
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    record_dirs = args.record_dir or list(DEFAULT_RECORD_DIRS)
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    samples_by_split: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    samples_by_case: dict[str, list[dict[str, Any]]] = {}
    skipped_cases: list[dict[str, Any]] = []
    labeled_case_count = 0
    fallback_size_count = 0

    for path, case in placement_records(record_dirs):
        case_samples = []
        movable = case.get("movable_objects", [])
        if isinstance(movable, list):
            for index, obj in enumerate(movable):
                if not isinstance(obj, dict) or not obj.get("id"):
                    continue
                sample = sample_for_object(path, case, obj, index)
                if sample is None:
                    continue
                if sample["object"]["size_status"] != "source_lef_size":
                    fallback_size_count += 1
                case_samples.append(sample)
        if not case_samples:
            skipped_cases.append(
                {
                    "case_id": case.get("id"),
                    "source": rel(path),
                    "reason": "no movable objects with target_placement labels",
                }
            )
            continue
        labeled_case_count += 1
        samples_by_case[str(case["id"])] = case_samples

    case_splits = split_case_groups(list(samples_by_case))
    for case_id, case_samples in samples_by_case.items():
        split = case_splits[case_id]
        for sample in case_samples:
            sample["split"] = split
            samples_by_split[split].append(sample)

    split_paths = {}
    for split, samples in samples_by_split.items():
        path = out_dir / f"{split}.jsonl"
        write_jsonl(path, samples)
        split_paths[split] = rel(path)

    sample_count = sum(len(samples) for samples in samples_by_split.values())
    errors = []
    if sample_count == 0:
        errors.append("no supervised macro-placement samples were generated")
    if labeled_case_count >= 3:
        empty_splits = [split for split, samples in samples_by_split.items() if not samples]
        if empty_splits:
            errors.append(f"empty supervised dataset split(s): {', '.join(empty_splits)}")
    report = {
        "schema": "eliza.ai_eda.macro_placement_supervised_dataset_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "record_dirs": [rel(path) for path in record_dirs],
        "labeled_case_count": labeled_case_count,
        "skipped_case_count": len(skipped_cases),
        "sample_count": sample_count,
        "error_count": len(errors),
        "errors": errors,
        "fallback_size_sample_count": fallback_size_count,
        "case_split_counts": {
            split: sum(1 for item in case_splits.values() if item == split)
            for split in ("train", "val", "test")
        },
        "split_counts": {split: len(samples) for split, samples in samples_by_split.items()},
        "splits": split_paths,
        "skipped_cases": skipped_cases,
        "next_required_gates": [
            "train a supervised macro-placement model on train.jsonl",
            "evaluate on validation/test splits without case leakage",
            "emit quarantined eda.e1_candidate.v1 manifests",
            "replay selected candidates through OpenLane/OpenROAD before any quality claim",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "macro_placement_supervised_dataset_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_supervised_dataset {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.macro_placement_supervised_dataset "
        f"samples={sample_count} cases={labeled_case_count} "
        f"fallback_sizes={fallback_size_count} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
