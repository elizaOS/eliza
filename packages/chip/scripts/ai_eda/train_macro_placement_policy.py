#!/usr/bin/env python3
"""Run deterministic macro-placement baselines over normalized placement cases.

This is the first local policy-training/evaluation spine for E1 macro placement.
It is intentionally simple: the baselines learn no private state, place movable
macros on legal grid slots, and emit quarantined candidate manifests. The output
is useful as plumbing and lower-bound evidence, not as a placement quality or
tapeout claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIRS = (
    ROOT / "build/ai_eda/internal_dataset_fixtures/validation/records",
    ROOT / "build/ai_eda/e1_openlane_conversion/validation/records",
    ROOT / "build/ai_eda/tilos_macroplacement/validation/records",
    ROOT / "build/ai_eda/e1_softmacro_cases/validation/records",
    ROOT / "build/ai_eda/e1_macro_array_cases/validation/records",
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_policy"
CLAIM_BOUNDARY = "macro_placement_baseline_only_no_openroad_replay_or_release_claim"


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
        paths = sorted(directory.glob("*.json")) + sorted(directory.glob("*.yaml"))
        for path in paths:
            record = load_record(path)
            if record.get("schema") == "eda.placement_case.v1":
                records.append((path, record))
    return records


def object_size_um(obj: dict[str, Any]) -> tuple[float, float]:
    width = obj.get("width_um")
    height = obj.get("height_um")
    return float(width if width is not None else 1.0), float(height if height is not None else 1.0)


def centered_location(core: list[Any], obj: dict[str, Any]) -> tuple[float, float]:
    width, height = object_size_um(obj)
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    x = (min_x + max_x - width) / 2.0
    y = (min_y + max_y - height) / 2.0
    x = min(max(x, min_x), max_x - width)
    y = min(max(y, min_y), max_y - height)
    return x, y


def grid_locations(core: list[Any], movable: list[dict[str, Any]]) -> list[tuple[float, float]]:
    if len(movable) == 1:
        return [centered_location(core, movable[0])]
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    core_w = max_x - min_x
    core_h = max_y - min_y
    max_obj_w = max(object_size_um(obj)[0] for obj in movable)
    max_obj_h = max(object_size_um(obj)[1] for obj in movable)
    grid_options = []
    for cols_candidate in range(1, len(movable) + 1):
        rows_candidate = math.ceil(len(movable) / cols_candidate)
        cell_w = core_w / cols_candidate
        cell_h = core_h / rows_candidate
        overflow_w = max(max_obj_w - cell_w, 0.0)
        overflow_h = max(max_obj_h - cell_h, 0.0)
        aspect_error = abs((cols_candidate / rows_candidate) - (core_w / core_h))
        grid_options.append(
            (
                overflow_w + overflow_h,
                aspect_error,
                abs(cols_candidate - rows_candidate),
                cols_candidate,
                rows_candidate,
            )
        )
    _overflow, _aspect_error, _shape_error, cols, rows = min(grid_options)
    locations: list[tuple[float, float]] = []
    for index, obj in enumerate(movable):
        row = index // cols
        col = index % cols
        width, height = object_size_um(obj)
        cell_w = core_w / cols
        cell_h = core_h / rows
        x = min_x + col * cell_w + max((cell_w - width) / 2.0, 0.0)
        y = min_y + row * cell_h + max((cell_h - height) / 2.0, 0.0)
        locations.append((min(max(x, min_x), max_x - width), min(max(y, min_y), max_y - height)))
    return locations


def target_aware_grid_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Assign grid locations to macros by nearest available labeled target."""
    locations = grid_locations(core, movable)
    if (
        len(locations) <= 1
        or len(movable) > 64
        or not all(isinstance(obj.get("target_placement"), dict) for obj in movable)
    ):
        return locations

    remaining = set(range(len(locations)))
    assigned: list[tuple[float, float] | None] = [None] * len(movable)
    for obj_index, obj in sorted(
        enumerate(movable),
        key=lambda item: str(item[1].get("id", "")),
    ):
        target = obj["target_placement"]
        target_x = float(target["x_um"])
        target_y = float(target["y_um"])
        best_location_index = min(
            remaining,
            key=lambda loc_index: math.hypot(
                locations[loc_index][0] - target_x,
                locations[loc_index][1] - target_y,
            ),
        )
        assigned[obj_index] = clamp_location_to_core(core, obj, locations[best_location_index])
        remaining.remove(best_location_index)

    candidate_locations = [
        location if location is not None else locations[index]
        for index, location in enumerate(assigned)
    ]
    if legal_locations(core, movable, candidate_locations):
        return candidate_locations
    return locations


def location_boxes(
    locations: list[tuple[float, float]],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float, float, float]]:
    boxes = []
    for (x_um, y_um), obj in zip(locations, movable, strict=False):
        width, height = object_size_um(obj)
        boxes.append((x_um, y_um, x_um + width, y_um + height))
    return boxes


def boxes_overlap(
    left: tuple[float, float, float, float], right: tuple[float, float, float, float]
) -> bool:
    return left[0] < right[2] and right[0] < left[2] and left[1] < right[3] and right[1] < left[3]


def legal_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
    locations: list[tuple[float, float]],
) -> bool:
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    for (x_um, y_um), obj in zip(locations, movable, strict=False):
        width, height = object_size_um(obj)
        if x_um < min_x or y_um < min_y or x_um + width > max_x or y_um + height > max_y:
            return False
    boxes = location_boxes(locations, movable)
    for left_index, left in enumerate(boxes):
        if any(boxes_overlap(left, right) for right in boxes[left_index + 1 :]):
            return False
    return True


def clamp_location_to_core(
    core: list[Any],
    obj: dict[str, Any],
    location: tuple[float, float],
) -> tuple[float, float]:
    width, height = object_size_um(obj)
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    return (
        min(max(location[0], min_x), max_x - width),
        min(max(location[1], min_y), max_y - height),
    )


def target_repair_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Greedily snap labeled macros from grid slots to legal target locations."""
    locations = target_aware_grid_locations(core, movable)
    if (
        len(locations) <= 1
        or len(movable) > 64
        or not all(isinstance(obj.get("target_placement"), dict) for obj in movable)
    ):
        return locations

    order = sorted(
        range(len(movable)),
        key=lambda index: math.hypot(
            locations[index][0] - float(movable[index]["target_placement"]["x_um"]),
            locations[index][1] - float(movable[index]["target_placement"]["y_um"]),
        ),
        reverse=True,
    )
    for obj_index in order:
        obj = movable[obj_index]
        target = obj["target_placement"]
        current_score = mean_target_distance(locations, movable)
        repaired = list(locations)
        repaired[obj_index] = clamp_location_to_core(
            core,
            obj,
            (float(target["x_um"]), float(target["y_um"])),
        )
        if (
            legal_locations(core, movable, repaired)
            and mean_target_distance(repaired, movable) <= current_score
        ):
            locations = repaired

    return locations


def deterministic_fraction(*parts: Any) -> float:
    digest = hashlib.sha256("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()
    return int(digest[:12], 16) / float(16**12 - 1)


def circuit_training_proxy_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Deterministic CT-style proxy: target-aware constructive placement."""
    return target_aware_grid_locations(core, movable)


def simulated_annealing_proxy_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Small deterministic SA proxy over legal swaps and target-distance score."""
    locations = target_aware_grid_locations(core, movable)
    if len(locations) <= 1:
        return locations
    if len(movable) > 64:
        return locations

    best = list(locations)
    best_score = mean_target_distance(best, movable)
    # Deterministic bounded search: enough to exercise the lane without hiding
    # replay requirements behind an expensive optimizer.
    for step in range(min(32, len(movable) * 4)):
        left = step % len(movable)
        right = int(deterministic_fraction("sa", step, len(movable)) * len(movable)) % len(movable)
        if left == right:
            right = (right + 1) % len(movable)
        candidate = list(best)
        candidate[left], candidate[right] = candidate[right], candidate[left]
        if not legal_locations(core, movable, candidate):
            continue
        score = mean_target_distance(candidate, movable)
        if score <= best_score:
            best = candidate
            best_score = score
    return best


def hier_rtlmp_proxy_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Recursive-bisection proxy for OpenROAD Hier-RTLMP-style grouping."""
    if not movable:
        return []
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    ordered = sorted(
        enumerate(movable),
        key=lambda item: (
            float(item[1].get("target_placement", {}).get("x_um", min_x))
            if isinstance(item[1].get("target_placement"), dict)
            else deterministic_fraction("hier", item[1].get("id", item[0])),
            str(item[1].get("id", item[0])),
        ),
    )
    assigned: list[tuple[float, float] | None] = [None] * len(movable)

    def place(
        group: list[tuple[int, dict[str, Any]]], box: tuple[float, float, float, float]
    ) -> None:
        if not group:
            return
        if len(group) == 1:
            index, obj = group[0]
            width, height = object_size_um(obj)
            x = box[0] + max((box[2] - box[0] - width) / 2.0, 0.0)
            y = box[1] + max((box[3] - box[1] - height) / 2.0, 0.0)
            assigned[index] = clamp_location_to_core(core, obj, (x, y))
            return
        span_x = box[2] - box[0]
        span_y = box[3] - box[1]
        mid = max(1, len(group) // 2)
        if span_x >= span_y:
            split = box[0] + span_x * (mid / len(group))
            place(group[:mid], (box[0], box[1], split, box[3]))
            place(group[mid:], (split, box[1], box[2], box[3]))
        else:
            split = box[1] + span_y * (mid / len(group))
            place(group[:mid], (box[0], box[1], box[2], split))
            place(group[mid:], (box[0], split, box[2], box[3]))

    place(ordered, (min_x, min_y, max_x, max_y))
    locations = [
        location if location is not None else centered_location(core, movable[index])
        for index, location in enumerate(assigned)
    ]
    if len(movable) > 64:
        return target_aware_grid_locations(core, movable)
    return (
        locations
        if legal_locations(core, movable, locations)
        else target_aware_grid_locations(core, movable)
    )


def chipdiffusion_proxy_locations(
    core: list[Any],
    movable: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Deterministic diffusion-style proxy: sampled legal denoise candidates."""
    base = target_aware_grid_locations(core, movable)
    if len(base) <= 1:
        return base
    if len(movable) > 64:
        return base
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    best = list(base)
    best_score = mean_target_distance(best, movable)
    for sample in range(12):
        candidate = []
        for index, obj in enumerate(movable):
            width, height = object_size_um(obj)
            target = obj.get("target_placement")
            if isinstance(target, dict):
                anchor_x = float(target["x_um"])
                anchor_y = float(target["y_um"])
            else:
                anchor_x, anchor_y = base[index]
            radius_x = max((max_x - min_x - width) / (sample + 4), 0.0)
            radius_y = max((max_y - min_y - height) / (sample + 4), 0.0)
            jitter_x = (
                deterministic_fraction("diff-x", sample, obj.get("id", index)) - 0.5
            ) * radius_x
            jitter_y = (
                deterministic_fraction("diff-y", sample, obj.get("id", index)) - 0.5
            ) * radius_y
            candidate.append(
                clamp_location_to_core(core, obj, (anchor_x + jitter_x, anchor_y + jitter_y))
            )
        if not legal_locations(core, movable, candidate):
            continue
        score = mean_target_distance(candidate, movable)
        if score <= best_score:
            best = candidate
            best_score = score
    return best


def mean_target_distance(
    locations: list[tuple[float, float]],
    movable: list[dict[str, Any]],
) -> float:
    distances = []
    for (x_um, y_um), obj in zip(locations, movable, strict=False):
        target = obj.get("target_placement")
        if not isinstance(target, dict):
            continue
        distances.append(math.hypot(x_um - float(target["x_um"]), y_um - float(target["y_um"])))
    return sum(distances) / len(distances) if distances else 0.0


def overlap_metrics(
    changes: list[dict[str, Any]],
    movable_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    boxes: list[tuple[float, float, float, float]] = []
    for change in changes:
        obj_id = change["target"].removeprefix("placement.")
        obj = movable_by_id.get(obj_id, {})
        width, height = object_size_um(obj)
        value = change["value"]
        x = float(value["x_um"])
        y = float(value["y_um"])
        boxes.append((x, y, x + width, y + height))

    if len(boxes) > 96:
        return {
            "overlap_count": 0,
            "overlap_area_um2": None,
            "worst_overlap_area_um2": None,
            "overlap_check_status": "skipped_large_case_pre_replay_guarded_by_openroad",
        }

    overlaps = 0
    total_area = 0.0
    worst_area = 0.0
    for left_index, left in enumerate(boxes):
        for right in boxes[left_index + 1 :]:
            width = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
            height = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
            area = width * height
            if area <= 0.0:
                continue
            overlaps += 1
            total_area += area
            worst_area = max(worst_area, area)
    return {
        "overlap_count": overlaps,
        "overlap_area_um2": round(total_area, 6),
        "worst_overlap_area_um2": round(worst_area, 6),
        "overlap_check_status": "exact_pairwise",
    }


def score_candidate(
    core: list[Any],
    movable: list[dict[str, Any]],
    changes: list[dict[str, Any]],
) -> dict[str, Any]:
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    center_x = (min_x + max_x) / 2.0
    center_y = (min_y + max_y) / 2.0
    movable_by_id = {str(obj.get("id")): obj for obj in movable}
    center_distances = []
    target_distances = []
    target_labels = 0
    out_of_bounds = 0
    for change in changes:
        obj_id = change["target"].removeprefix("placement.")
        obj = movable_by_id.get(obj_id, {})
        width, height = object_size_um(obj)
        value = change["value"]
        x_um = float(value["x_um"])
        y_um = float(value["y_um"])
        center_distances.append(math.hypot(x_um - center_x, y_um - center_y))
        if x_um < min_x or y_um < min_y or x_um + width > max_x or y_um + height > max_y:
            out_of_bounds += 1
        target = obj.get("target_placement")
        if isinstance(target, dict):
            target_labels += 1
            target_distances.append(
                math.hypot(x_um - float(target["x_um"]), y_um - float(target["y_um"]))
            )
    mean_center_distance_um = (
        sum(center_distances) / len(center_distances) if center_distances else None
    )
    mean_target_distance_um = (
        sum(target_distances) / len(target_distances) if target_distances else None
    )
    overlaps = overlap_metrics(changes, movable_by_id)
    penalty = (int(overlaps["overlap_count"]) * 1_000_000.0) + (out_of_bounds * 1_000_000.0)
    score_basis = (
        mean_target_distance_um if mean_target_distance_um is not None else mean_center_distance_um
    )
    return {
        "proxy": (
            "target_distance_when_labels_exist_else_center_distance_lower_is_better_"
            "with_overlap_boundary_penalties_no_wirelength_or_timing_claim"
        ),
        "movable_count": len(changes),
        "target_label_count": target_labels,
        "target_label_coverage": round(target_labels / len(changes), 6) if changes else 0.0,
        "mean_center_distance_um": round(mean_center_distance_um, 6)
        if mean_center_distance_um is not None
        else None,
        "mean_target_distance_um": round(mean_target_distance_um, 6)
        if mean_target_distance_um is not None
        else None,
        **overlaps,
        "out_of_bounds_count": out_of_bounds,
        "score": round(-(score_basis + penalty), 6) if score_basis is not None else None,
    }


def candidate_for_case(
    case: dict[str, Any],
    run_id: str,
    model_path: Path,
    policy: str,
) -> dict[str, Any] | None:
    movable = case.get("movable_objects")
    if not isinstance(movable, list) or not movable:
        return None
    core = case["floorplan"]["core_area_um"]
    changes = []
    if policy == "target_aware_grid":
        locations = target_aware_grid_locations(core, movable)
        candidate_prefix = "macro-placement-target-aware-grid"
    elif policy == "target_repair_search":
        locations = target_repair_locations(core, movable)
        candidate_prefix = "macro-placement-target-repair-search"
    elif policy == "circuit_training_proxy":
        locations = circuit_training_proxy_locations(core, movable)
        candidate_prefix = "macro-placement-circuit-training-proxy"
    elif policy == "simulated_annealing_proxy":
        locations = simulated_annealing_proxy_locations(core, movable)
        candidate_prefix = "macro-placement-simulated-annealing-proxy"
    elif policy == "hier_rtlmp_proxy":
        locations = hier_rtlmp_proxy_locations(core, movable)
        candidate_prefix = "macro-placement-hier-rtlmp-proxy"
    elif policy == "chipdiffusion_proxy":
        locations = chipdiffusion_proxy_locations(core, movable)
        candidate_prefix = "macro-placement-chipdiffusion-proxy"
    elif policy == "center_legal_baseline":
        locations = grid_locations(core, movable)
        candidate_prefix = "macro-placement-center-baseline"
    else:
        raise ValueError(f"unsupported policy {policy!r}")
    for obj, (x_um, y_um) in zip(movable, locations, strict=False):
        if not isinstance(obj, dict) or not obj.get("id"):
            continue
        changes.append(
            {
                "target": f"placement.{obj['id']}",
                "action": "move",
                "value": {
                    "x_um": round(x_um, 6),
                    "y_um": round(y_um, 6),
                    "orientation": obj.get("orientation", "N"),
                },
            }
        )
    if not changes:
        return None
    return {
        "schema": "eda.e1_candidate.v1",
        "id": f"{candidate_prefix}-{case['id']}-{run_id}",
        "candidate_type": "macro_placement",
        "design_bundle_id": case["design_bundle_id"],
        "generated_by": {
            "source": "scripts/ai_eda/train_macro_placement_policy.py",
            "model_or_tool": rel(model_path),
            "policy": policy,
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
            "completed_gates": ["baseline_policy_generation"],
        },
        "decision": {
            "status": "replayed_blocked",
            "reason": "baseline candidate is quarantined until deterministic OpenLane/OpenROAD replay and human PD review",
        },
        "claim_boundary": CLAIM_BOUNDARY,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    record_dirs = args.record_dir or list(DEFAULT_RECORD_DIRS)
    cases = placement_records(record_dirs)
    out_dir = args.out_root / args.run_id
    candidates_dir = out_dir / "candidates"
    candidates_dir.mkdir(parents=True, exist_ok=True)
    for stale_candidate in candidates_dir.glob(f"macro-placement-*-{args.run_id}.json"):
        stale_candidate.unlink(missing_ok=True)
    model_path = out_dir / "center_baseline_policy.json"

    model = {
        "schema": "eliza.ai_eda.macro_placement_policy.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "policies": [
            "center_legal_baseline",
            "target_aware_grid",
            "target_repair_search",
            "circuit_training_proxy",
            "simulated_annealing_proxy",
            "hier_rtlmp_proxy",
            "chipdiffusion_proxy",
        ],
        "proxy_policy_boundary": (
            "CT/SA/Hier-RTLMP/ChipDiffusion lanes are deterministic local proxies "
            "until their external tools are fetched, converted, and replayed"
        ),
        "claim_boundary": CLAIM_BOUNDARY,
        "training_inputs": [rel(path) for path, _case in cases],
        "learned_parameters": {},
        "release_use_allowed": False,
    }
    model_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    emitted: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    for path, case in cases:
        case_candidates = []
        for policy in model["policies"]:
            candidate = candidate_for_case(case, args.run_id, model_path, policy)
            if candidate is not None:
                case_candidates.append(candidate)
        if not case_candidates:
            blocked.append(
                {
                    "case_id": case.get("id"),
                    "source": rel(path),
                    "reason": "no movable_objects in placement case",
                }
            )
            continue
        for candidate in case_candidates:
            score = score_candidate(
                case["floorplan"]["core_area_um"],
                case["movable_objects"],
                candidate["proposed_changes"],
            )
            candidate["generated_by"]["score"] = score
            candidate_path = candidates_dir / f"{candidate['id']}.json"
            candidate_path.write_text(
                json.dumps(candidate, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            emitted.append(
                {
                    "path": rel(candidate_path),
                    "id": candidate["id"],
                    "case_id": case["id"],
                    "policy": candidate["generated_by"]["policy"],
                    "score": score,
                }
            )

    comparisons = []
    for case_id in sorted({item["case_id"] for item in emitted}):
        case_items = [item for item in emitted if item["case_id"] == case_id]
        by_policy = {item["policy"]: item for item in case_items}
        reference = by_policy.get("center_legal_baseline")
        if reference is None:
            continue
        reference_target = reference["score"].get("mean_target_distance_um")
        policy_comparisons = []
        for policy in model["policies"]:
            item = by_policy.get(policy)
            if item is None:
                continue
            target_distance = item["score"].get("mean_target_distance_um")
            improvement = None
            if reference_target is not None and target_distance is not None:
                improvement = round(reference_target - target_distance, 6)
            policy_comparisons.append(
                {
                    "policy": policy,
                    "candidate_id": item["id"],
                    "score": item["score"].get("score"),
                    "mean_target_distance_um": target_distance,
                    "mean_target_distance_improvement_vs_center_um": improvement,
                    "overlap_count": item["score"].get("overlap_count"),
                    "out_of_bounds_count": item["score"].get("out_of_bounds_count"),
                }
            )
        comparisons.append(
            {
                "case_id": case_id,
                "reference_policy": "center_legal_baseline",
                "policy_comparisons": policy_comparisons,
            }
        )

    report_status = "PASS_WITH_BLOCKED_CASES" if blocked else "PASS"
    report = {
        "schema": "eliza.ai_eda.macro_placement_baseline_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "status": report_status,
        "claim_boundary": CLAIM_BOUNDARY,
        "record_dirs": [rel(path) for path in record_dirs],
        "case_count": len(cases),
        "candidate_count": len(emitted),
        "blocked_case_count": len(blocked),
        "candidates": emitted,
        "comparisons": comparisons,
        "blocked_cases": blocked,
        "next_required_gates": [
            "run scripts/ai_eda/check_candidate_manifests.py on emitted candidates",
            "replay any candidate through OpenLane/OpenROAD before using as evidence",
            "replace proxy CT/SA/Hier-RTLMP/ChipDiffusion adapters with real external-method inference after payloads are fetched and converted",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "macro_placement_baseline_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(
        f"STATUS: {report_status} ai_eda.macro_placement_baseline "
        f"cases={len(cases)} candidates={len(emitted)} blocked={len(blocked)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
