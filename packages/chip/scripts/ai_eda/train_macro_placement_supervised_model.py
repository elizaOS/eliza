#!/usr/bin/env python3
"""Train a dependency-free supervised macro-placement baseline.

This is a CPU-safe training/inference spine for CUDA-host replacement. It
learns deterministic mean normalized placements from the supervised JSONL
dataset, evaluates validation/test MAE, and emits quarantined placement
candidates for normalized placement cases. It does not replay candidates or
claim PPA quality.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET_ROOT = ROOT / "build/ai_eda/macro_placement_supervised_dataset"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_supervised_model"
DEFAULT_RECORD_DIRS = (
    ROOT / "build/ai_eda/internal_dataset_fixtures/validation/records",
    ROOT / "build/ai_eda/e1_openlane_conversion/validation/records",
    ROOT / "build/ai_eda/tilos_macroplacement/validation/records",
    ROOT / "build/ai_eda/chipbench_d/validation/records",
    ROOT / "build/ai_eda/e1_softmacro_cases/validation/records",
    ROOT / "build/ai_eda/e1_macro_array_cases/validation/records",
)
CLAIM_BOUNDARY = "macro_placement_supervised_model_only_no_openroad_replay_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_record(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            data = json.loads(line)
            if not isinstance(data, dict):
                raise ValueError(f"{path}: expected JSON object rows")
            rows.append(data)
    return rows


def placement_records(record_dirs: list[Path]) -> list[tuple[Path, dict[str, Any]]]:
    records = []
    for directory in record_dirs:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.json")) + sorted(directory.glob("*.yaml")):
            record = load_record(path)
            if record.get("schema") == "eda.placement_case.v1":
                records.append((path, record))
    return records


def mean_point(samples: list[dict[str, Any]]) -> dict[str, Any]:
    x_values = [float(sample["label"]["x_over_core"]) for sample in samples]
    y_values = [float(sample["label"]["y_over_core"]) for sample in samples]
    orientations = Counter(str(sample["label"].get("orientation", "N")) for sample in samples)
    return {
        "count": len(samples),
        "x_over_core": sum(x_values) / len(x_values),
        "y_over_core": sum(y_values) / len(y_values),
        "orientation": orientations.most_common(1)[0][0],
    }


def train_model(train_samples: list[dict[str, Any]]) -> dict[str, Any]:
    by_macro: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in train_samples:
        obj = sample["object"]
        macro = obj.get("macro_name")
        if macro:
            by_macro[str(macro)].append(sample)
        by_type[str(obj.get("type", "unknown"))].append(sample)
    return {
        "schema": "eliza.ai_eda.macro_placement_supervised_mean_model.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "algorithm": "macro_name_then_type_then_global_mean_normalized_placement",
        "global": mean_point(train_samples),
        "by_macro_name": {
            key: mean_point(values) for key, values in sorted(by_macro.items()) if values
        },
        "by_type": {key: mean_point(values) for key, values in sorted(by_type.items()) if values},
        "release_use_allowed": False,
    }


def predict_normalized(model: dict[str, Any], obj: dict[str, Any]) -> tuple[float, float, str, str]:
    macro = obj.get("macro_name")
    if macro and str(macro) in model["by_macro_name"]:
        item = model["by_macro_name"][str(macro)]
        return (
            float(item["x_over_core"]),
            float(item["y_over_core"]),
            str(item["orientation"]),
            "macro_name_mean",
        )
    obj_type = str(obj.get("type", "unknown"))
    if obj_type in model["by_type"]:
        item = model["by_type"][obj_type]
        return (
            float(item["x_over_core"]),
            float(item["y_over_core"]),
            str(item["orientation"]),
            "type_mean",
        )
    item = model["global"]
    return (
        float(item["x_over_core"]),
        float(item["y_over_core"]),
        str(item["orientation"]),
        "global_mean",
    )


def evaluate_split(
    model: dict[str, Any], samples: list[dict[str, Any]], split: str
) -> dict[str, Any]:
    if not samples:
        return {"split": split, "sample_count": 0, "mae_x_over_core": None, "mae_y_over_core": None}
    x_error = 0.0
    y_error = 0.0
    source_counts: Counter[str] = Counter()
    for sample in samples:
        pred_x, pred_y, _orient, source = predict_normalized(model, sample["object"])
        source_counts[source] += 1
        x_error += abs(pred_x - float(sample["label"]["x_over_core"]))
        y_error += abs(pred_y - float(sample["label"]["y_over_core"]))
    return {
        "split": split,
        "sample_count": len(samples),
        "mae_x_over_core": round(x_error / len(samples), 8),
        "mae_y_over_core": round(y_error / len(samples), 8),
        "mean_l1_over_core": round((x_error + y_error) / (2 * len(samples)), 8),
        "prediction_source_counts": dict(sorted(source_counts.items())),
    }


def object_size_um(obj: dict[str, Any]) -> tuple[float, float]:
    width = obj.get("width_um")
    height = obj.get("height_um")
    return float(width if width is not None else 1.0), float(height if height is not None else 1.0)


def clamp_location(
    core: list[Any], obj: dict[str, Any], x_um: float, y_um: float
) -> tuple[float, float]:
    width, height = object_size_um(obj)
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    return (
        min(max(x_um, min_x), max_x - width),
        min(max(y_um, min_y), max_y - height),
    )


def grid_locations(core: list[Any], movable: list[dict[str, Any]]) -> list[tuple[float, float]]:
    if len(movable) == 1:
        min_x, min_y, max_x, max_y = [float(value) for value in core]
        width, height = object_size_um(movable[0])
        return [((min_x + max_x - width) / 2.0, (min_y + max_y - height) / 2.0)]
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    core_w = max_x - min_x
    core_h = max_y - min_y
    max_obj_w = max(object_size_um(obj)[0] for obj in movable)
    max_obj_h = max(object_size_um(obj)[1] for obj in movable)
    options = []
    for cols_candidate in range(1, len(movable) + 1):
        rows_candidate = math.ceil(len(movable) / cols_candidate)
        cell_w = core_w / cols_candidate
        cell_h = core_h / rows_candidate
        overflow = max(max_obj_w - cell_w, 0.0) + max(max_obj_h - cell_h, 0.0)
        aspect_error = abs((cols_candidate / rows_candidate) - (core_w / core_h))
        options.append(
            (
                overflow,
                aspect_error,
                abs(cols_candidate - rows_candidate),
                cols_candidate,
                rows_candidate,
            )
        )
    _overflow, _aspect_error, _shape_error, cols, rows = min(options)
    locations = []
    for index, obj in enumerate(movable):
        row = index // cols
        col = index % cols
        width, height = object_size_um(obj)
        cell_w = core_w / cols
        cell_h = core_h / rows
        x_um = min_x + col * cell_w + max((cell_w - width) / 2.0, 0.0)
        y_um = min_y + row * cell_h + max((cell_h - height) / 2.0, 0.0)
        locations.append(clamp_location(core, obj, x_um, y_um))
    return locations


def legalized_prediction_locations(
    model: dict[str, Any],
    core: list[Any],
    movable: list[dict[str, Any]],
) -> tuple[list[tuple[float, float, str, str]], dict[str, int]]:
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    core_w = max_x - min_x
    core_h = max_y - min_y
    predicted = []
    source_counts: Counter[str] = Counter()
    for index, obj in enumerate(movable):
        pred_x, pred_y, orient, source = predict_normalized(model, obj)
        source_counts[source] += 1
        width, height = object_size_um(obj)
        x_um = min_x + pred_x * core_w
        y_um = min_y + pred_y * core_h
        x_um, y_um = clamp_location(core, obj, x_um, y_um)
        predicted.append((index, x_um + width / 2.0, y_um + height / 2.0, orient, source))

    slots = grid_locations(core, movable)
    indexed_slots = sorted(enumerate(slots), key=lambda item: (item[1][1], item[1][0], item[0]))
    indexed_predictions = sorted(predicted, key=lambda item: (item[2], item[1], item[0]))
    locations_by_object: list[tuple[float, float, str, str] | None] = [None] * len(movable)
    for (obj_index, _px, _py, orient, source), (_slot_index, slot) in zip(
        indexed_predictions,
        indexed_slots,
    ):
        locations_by_object[obj_index] = (slot[0], slot[1], orient, source)
    return [
        item if item is not None else (slots[index][0], slots[index][1], "N", "grid_fallback")
        for index, item in enumerate(locations_by_object)
    ], dict(sorted(source_counts.items()))


def score_candidate(case: dict[str, Any], changes: list[dict[str, Any]]) -> dict[str, Any]:
    movable_by_id = {
        str(obj["id"]): obj
        for obj in case.get("movable_objects", [])
        if isinstance(obj, dict) and obj.get("id")
    }
    distances = []
    target_labels = 0
    for change in changes:
        object_id = str(change["target"]).removeprefix("placement.")
        obj = movable_by_id.get(object_id)
        if not obj:
            continue
        target = obj.get("target_placement")
        if not isinstance(target, dict):
            continue
        target_labels += 1
        value = change["value"]
        distances.append(
            math.hypot(
                float(value["x_um"]) - float(target["x_um"]),
                float(value["y_um"]) - float(target["y_um"]),
            )
        )
    mean_target = sum(distances) / len(distances) if distances else None
    return {
        "proxy": "supervised_mean_model_legalized_grid_target_distance_no_timing_or_ppa_claim",
        "movable_count": len(changes),
        "target_label_count": target_labels,
        "mean_target_distance_um": round(mean_target, 6) if mean_target is not None else None,
        "score": round(-mean_target, 6) if mean_target is not None else None,
    }


def geometry_metrics(case: dict[str, Any], changes: list[dict[str, Any]]) -> dict[str, int]:
    movable_by_id = {
        str(obj["id"]): obj
        for obj in case.get("movable_objects", [])
        if isinstance(obj, dict) and obj.get("id")
    }
    core = [float(value) for value in case["floorplan"]["core_area_um"]]
    min_x, min_y, max_x, max_y = core
    boxes = []
    unknown = 0
    out_of_bounds = 0
    for change in changes:
        object_id = str(change["target"]).removeprefix("placement.")
        obj = movable_by_id.get(object_id)
        if obj is None:
            unknown += 1
            continue
        value = change["value"]
        x_um = float(value["x_um"])
        y_um = float(value["y_um"])
        width, height = object_size_um(obj)
        box = (x_um, y_um, x_um + width, y_um + height)
        boxes.append(box)
        if box[0] < min_x or box[1] < min_y or box[2] > max_x or box[3] > max_y:
            out_of_bounds += 1
    overlaps = 0
    for left_index, left in enumerate(boxes):
        for right in boxes[left_index + 1 :]:
            overlap_w = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
            overlap_h = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
            if overlap_w * overlap_h > 0.0:
                overlaps += 1
    return {
        "unknown_target_count": unknown,
        "out_of_bounds_count": out_of_bounds,
        "overlap_count": overlaps,
    }


def candidate_for_case(
    case: dict[str, Any],
    run_id: str,
    model_path: Path,
    model: dict[str, Any],
) -> dict[str, Any] | None:
    movable = case.get("movable_objects")
    if not isinstance(movable, list) or not movable:
        return None
    core = case["floorplan"]["core_area_um"]
    locations, source_counts = legalized_prediction_locations(model, core, movable)
    changes = []
    for obj, (x_um, y_um, orientation, _source) in zip(movable, locations):
        if not isinstance(obj, dict) or not obj.get("id"):
            continue
        changes.append(
            {
                "target": f"placement.{obj['id']}",
                "action": "move",
                "value": {
                    "x_um": round(x_um, 6),
                    "y_um": round(y_um, 6),
                    "orientation": orientation,
                },
            }
        )
    if not changes:
        return None
    candidate = {
        "schema": "eda.e1_candidate.v1",
        "id": f"macro-placement-supervised-mean-{case['id']}-{run_id}",
        "candidate_type": "macro_placement",
        "design_bundle_id": case["design_bundle_id"],
        "generated_by": {
            "source": "scripts/ai_eda/train_macro_placement_supervised_model.py",
            "model_or_tool": rel(model_path),
            "policy": "supervised_mean_legalized_grid",
            "prediction_source_counts": source_counts,
        },
        "proposed_changes": changes,
        "validation_ladder": {
            "required_gates": [
                "schema_validation",
                "deterministic_openroad_replay",
                "timing_check",
                "global_route_or_congestion_check",
                "drc_check",
                "antenna_check",
                "power_or_pdn_check",
                "human_review",
            ],
            "completed_gates": ["supervised_model_training", "supervised_model_inference"],
        },
        "decision": {
            "status": "replayed_blocked",
            "reason": "supervised candidate is quarantined until deterministic OpenLane/OpenROAD replay and human PD review",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    candidate["generated_by"]["score"] = score_candidate(case, changes)
    candidate["generated_by"]["geometry"] = geometry_metrics(case, changes)
    return candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--dataset-root", type=Path, default=DEFAULT_DATASET_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dataset_dir = args.dataset_root / args.run_id
    train_samples = load_jsonl(dataset_dir / "train.jsonl")
    val_samples = load_jsonl(dataset_dir / "val.jsonl")
    test_samples = load_jsonl(dataset_dir / "test.jsonl")
    if not train_samples:
        print("STATUS: FAIL ai_eda.macro_placement_supervised_model empty training split")
        return 1

    out_dir = args.out_root / args.run_id
    candidates_dir = out_dir / "candidates"
    out_dir.mkdir(parents=True, exist_ok=True)
    candidates_dir.mkdir(parents=True, exist_ok=True)
    for stale_candidate in candidates_dir.glob(f"macro-placement-supervised-*-{args.run_id}.json"):
        stale_candidate.unlink(missing_ok=True)

    model = train_model(train_samples)
    model["run_id"] = args.run_id
    model["training_sample_count"] = len(train_samples)
    model_path = out_dir / "supervised_mean_model.json"
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    metrics = {
        "schema": "eliza.ai_eda.macro_placement_supervised_metrics.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "splits": [
            evaluate_split(model, train_samples, "train"),
            evaluate_split(model, val_samples, "val"),
            evaluate_split(model, test_samples, "test"),
        ],
        "release_use_allowed": False,
    }
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    emitted = []
    blocked = []
    record_dirs = args.record_dir or list(DEFAULT_RECORD_DIRS)
    for path, case in placement_records(record_dirs):
        candidate = candidate_for_case(case, args.run_id, model_path, model)
        if candidate is None:
            blocked.append(
                {
                    "case_id": case.get("id"),
                    "source": rel(path),
                    "reason": "no movable_objects in placement case",
                }
            )
            continue
        geometry = candidate["generated_by"]["geometry"]
        if (
            geometry["unknown_target_count"] > 0
            or geometry["out_of_bounds_count"] > 0
            or geometry["overlap_count"] > 0
        ):
            blocked.append(
                {
                    "case_id": case.get("id"),
                    "source": rel(path),
                    "reason": "supervised model candidate failed pre-replay geometry checks",
                    "geometry": geometry,
                }
            )
            continue
        candidate_path = candidates_dir / f"{candidate['id']}.json"
        candidate_path.write_text(
            json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        emitted.append(
            {
                "id": candidate["id"],
                "path": rel(candidate_path),
                "case_id": case["id"],
                "score": candidate["generated_by"]["score"],
            }
        )

    report = {
        "schema": "eliza.ai_eda.macro_placement_supervised_training_run.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "dataset_dir": rel(dataset_dir),
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "candidate_count": len(emitted),
        "blocked_case_count": len(blocked),
        "candidates": emitted,
        "blocked_cases": blocked,
        "next_required_gates": [
            "replace dependency-free mean baseline with CUDA model training",
            "rank candidates against deterministic baselines",
            "replay selected candidates through OpenLane/OpenROAD before any quality claim",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "supervised_training_run.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS_WITH_BLOCKED_CASES" if blocked else "PASS"
    print(
        f"STATUS: {status} ai_eda.macro_placement_supervised_model "
        f"train={len(train_samples)} val={len(val_samples)} test={len(test_samples)} "
        f"candidates={len(emitted)} blocked={len(blocked)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
