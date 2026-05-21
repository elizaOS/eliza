#!/usr/bin/env python3
"""Emit quarantined macro-placement candidates from a trained torch regressor.

This is the CUDA-host inference half of train_macro_placement_torch_regressor.py.
It loads the serialized PyTorch model, predicts normalized macro locations for
internal placement cases, legalizes those predictions onto deterministic grid
slots, and writes candidate manifests that still require OpenLane/OpenROAD
replay before any quality or release claim.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from train_macro_placement_supervised_model import (
    DEFAULT_RECORD_DIRS,
    geometry_metrics,
    grid_locations,
    object_size_um,
    placement_records,
    rel,
)
from train_macro_placement_torch_regressor import ORIENTATIONS, build_model, sample_features

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_ROOT = ROOT / "build/ai_eda/macro_placement_torch_regressor"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_torch_inference"
CLAIM_BOUNDARY = "macro_placement_torch_inference_only_no_openroad_replay_or_release_claim"


def import_torch() -> Any:
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "PyTorch is required for infer_macro_placement_torch_regressor.py; "
            "run this on the CUDA/MPS/CPU host that trained the torch regressor."
        ) from exc
    return torch


def select_device(torch: Any, requested: str) -> Any:
    if requested == "cuda" and not torch.cuda.is_available():
        raise SystemExit("cuda requested but torch.cuda.is_available() is false")
    mps_available = bool(
        hasattr(torch.backends, "mps")
        and torch.backends.mps.is_available()
        and torch.backends.mps.is_built()
    )
    if requested == "mps" and not mps_available:
        raise SystemExit("mps requested but torch MPS is unavailable")
    if requested == "auto" and torch.cuda.is_available():
        return torch.device("cuda")
    if requested == "auto" and mps_available:
        return torch.device("mps")
    return torch.device("cpu" if requested == "auto" else requested)


def load_model(torch: Any, model_path: Path, device: Any) -> tuple[Any, dict[str, Any]]:
    checkpoint = torch.load(model_path, map_location=device)
    if not isinstance(checkpoint, dict):
        raise ValueError(f"{model_path}: expected torch checkpoint dict")
    model_state = checkpoint.get("model_state_dict")
    if not isinstance(model_state, dict):
        raise ValueError(f"{model_path}: missing model_state_dict")
    model = build_model(torch).to(device)
    model.load_state_dict(model_state)
    model.eval()
    return model, checkpoint


def object_sample(case: dict[str, Any], obj: dict[str, Any], index: int) -> dict[str, Any]:
    normalized = dict(obj)
    normalized.setdefault("index", index)
    core = case["floorplan"]["core_area_um"]
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    core_width = max(max_x - min_x, 1.0)
    core_height = max(max_y - min_y, 1.0)
    width, height = object_size_um(normalized)
    normalized.setdefault("width_um", width)
    normalized.setdefault("height_um", height)
    normalized.setdefault("width_over_core", width / core_width)
    normalized.setdefault("height_over_core", height / core_height)
    return {
        "design_bundle_id": case["design_bundle_id"],
        "floorplan": {
            "core_area_um": core,
            "core_width_um": core_width,
            "core_height_um": core_height,
        },
        "object": normalized,
    }


def predicted_locations(
    torch: Any,
    model: Any,
    device: Any,
    case: dict[str, Any],
    movable: list[dict[str, Any]],
) -> tuple[list[tuple[float, float, str, str]], dict[str, int]]:
    core = case["floorplan"]["core_area_um"]
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    core_w = max(max_x - min_x, 1.0)
    core_h = max(max_y - min_y, 1.0)
    features = [sample_features(object_sample(case, obj, index)) for index, obj in enumerate(movable)]
    with torch.no_grad():
        output = model(torch.tensor(features, dtype=torch.float32, device=device))
        xy_values = output[:, :2].clamp(0.0, 1.0).detach().cpu().tolist()
        orientation_ids = output[:, 2:].argmax(dim=1).detach().cpu().tolist()

    predicted = []
    source_counts: Counter[str] = Counter()
    for index, (obj, xy, orientation_id) in enumerate(zip(movable, xy_values, orientation_ids, strict=True)):
        width, height = object_size_um(obj)
        x_um = min_x + float(xy[0]) * core_w
        y_um = min_y + float(xy[1]) * core_h
        predicted.append(
            (
                index,
                x_um + width / 2.0,
                y_um + height / 2.0,
                ORIENTATIONS[int(orientation_id)] if int(orientation_id) < len(ORIENTATIONS) else "N",
                "torch_regressor",
            )
        )
        source_counts["torch_regressor"] += 1

    slots = grid_locations(core, movable)
    indexed_slots = sorted(enumerate(slots), key=lambda item: (item[1][1], item[1][0], item[0]))
    indexed_predictions = sorted(predicted, key=lambda item: (item[2], item[1], item[0]))
    locations_by_object: list[tuple[float, float, str, str] | None] = [None] * len(movable)
    for (obj_index, _px, _py, orientation, source), (_slot_index, slot) in zip(
        indexed_predictions,
        indexed_slots,
        strict=True,
    ):
        locations_by_object[obj_index] = (slot[0], slot[1], orientation, source)
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
            ((float(value["x_um"]) - float(target["x_um"])) ** 2 + (float(value["y_um"]) - float(target["y_um"])) ** 2)
            ** 0.5
        )
    mean_target = sum(distances) / len(distances) if distances else None
    return {
        "proxy": "torch_regressor_legalized_grid_target_distance_no_timing_or_ppa_claim",
        "movable_count": len(changes),
        "target_label_count": target_labels,
        "mean_target_distance_um": round(mean_target, 6) if mean_target is not None else None,
        "score": round(-mean_target, 6) if mean_target is not None else None,
    }


def candidate_for_case(
    torch: Any,
    model: Any,
    device: Any,
    case: dict[str, Any],
    run_id: str,
    model_path: Path,
) -> dict[str, Any] | None:
    movable = case.get("movable_objects")
    if not isinstance(movable, list) or not movable:
        return None
    locations, source_counts = predicted_locations(torch, model, device, case, movable)
    changes = []
    for obj, (x_um, y_um, orientation, _source) in zip(movable, locations, strict=True):
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
        "id": f"macro-placement-torch-regressor-{case['id']}-{run_id}",
        "candidate_type": "macro_placement",
        "design_bundle_id": case["design_bundle_id"],
        "generated_by": {
            "source": "scripts/ai_eda/infer_macro_placement_torch_regressor.py",
            "model_or_tool": rel(model_path),
            "policy": "torch_regressor_legalized_grid",
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
            "completed_gates": ["torch_model_training", "torch_model_inference"],
        },
        "decision": {
            "status": "replayed_blocked",
            "reason": "torch-regressor candidate is quarantined until deterministic OpenLane/OpenROAD replay and human PD review",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }
    candidate["generated_by"]["score"] = score_candidate(case, changes)
    candidate["generated_by"]["geometry"] = geometry_metrics(case, changes)
    return candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--model-root", type=Path, default=DEFAULT_MODEL_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    parser.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    torch = import_torch()
    device = select_device(torch, args.device)
    model_path = args.model or args.model_root / args.run_id / "torch_regressor.pt"
    model, checkpoint = load_model(torch, model_path, device)
    out_dir = args.out_root / args.run_id
    candidates_dir = out_dir / "candidates"
    out_dir.mkdir(parents=True, exist_ok=True)
    candidates_dir.mkdir(parents=True, exist_ok=True)
    for stale_candidate in candidates_dir.glob(f"macro-placement-torch-regressor-*-{args.run_id}.json"):
        stale_candidate.unlink(missing_ok=True)

    emitted = []
    blocked = []
    for path, case in placement_records(args.record_dir or list(DEFAULT_RECORD_DIRS)):
        candidate = candidate_for_case(torch, model, device, case, args.run_id, model_path)
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
                    "reason": "torch-regressor candidate failed pre-replay geometry checks",
                    "geometry": geometry,
                }
            )
            continue
        candidate_path = candidates_dir / f"{candidate['id']}.json"
        candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        emitted.append(
            {
                "id": candidate["id"],
                "path": rel(candidate_path),
                "case_id": case["id"],
                "score": candidate["generated_by"]["score"],
            }
        )

    report = {
        "schema": "eliza.ai_eda.macro_placement_torch_inference_run.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "model": rel(model_path),
        "device": str(device),
        "checkpoint_claim_boundary": checkpoint.get("claim_boundary"),
        "candidate_count": len(emitted),
        "blocked_case_count": len(blocked),
        "candidates": emitted,
        "blocked_cases": blocked,
        "next_required_gates": [
            "rank torch-regressor candidates against deterministic and supervised baselines",
            "replay selected candidates through deterministic OpenLane/OpenROAD gates",
            "compare timing/congestion/DRC/antenna/power metrics before any source promotion",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "torch_inference_run.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS_WITH_BLOCKED_CASES" if blocked else "PASS"
    print(
        f"STATUS: {status} ai_eda.macro_placement_torch_inference "
        f"device={device} candidates={len(emitted)} blocked={len(blocked)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
