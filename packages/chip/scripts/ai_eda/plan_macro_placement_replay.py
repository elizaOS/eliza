#!/usr/bin/env python3
"""Create deterministic replay plans for macro-placement candidates.

The planner is deliberately non-mutating: it converts candidate manifests into
quarantined replay bundles under build/ and records the exact blockers before
any OpenLane/OpenROAD run is attempted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATE_DIR = ROOT / "build/ai_eda/macro_placement_policy/validation/candidates"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_replay"
DEFAULT_RECORD_DIRS = (
    ROOT / "build/ai_eda/internal_dataset_fixtures/validation/records",
    ROOT / "build/ai_eda/e1_openlane_conversion/validation/records",
    ROOT / "build/ai_eda/tilos_macroplacement/validation/records",
    ROOT / "build/ai_eda/e1_softmacro_cases/validation/records",
)
CLAIM_BOUNDARY = "macro_placement_replay_plan_only_no_openroad_execution_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")[:180]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def load_placement_cases(record_dirs: list[Path]) -> dict[str, tuple[Path, dict[str, Any]]]:
    cases: dict[str, tuple[Path, dict[str, Any]]] = {}
    for record_dir in record_dirs:
        if not record_dir.exists():
            continue
        for path in sorted(record_dir.glob("*.json")):
            try:
                record = load_json(path)
            except Exception:
                continue
            if record.get("schema") != "eda.placement_case.v1":
                continue
            design_bundle_id = record.get("design_bundle_id")
            if isinstance(design_bundle_id, str):
                cases[design_bundle_id] = (path, record)
    return cases


def candidate_paths(candidate_dirs: list[Path], explicit: list[Path]) -> list[Path]:
    if explicit:
        return sorted(explicit)
    paths: list[Path] = []
    for candidate_dir in candidate_dirs:
        if not candidate_dir.exists():
            continue
        paths.extend(sorted(candidate_dir.glob("*.json")))
    return sorted(paths)


def object_sizes(case: dict[str, Any]) -> dict[str, tuple[float, float]]:
    sizes: dict[str, tuple[float, float]] = {}
    for item in case.get("movable_objects", []):
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str):
            continue
        width = float(item.get("width_um", 0.0) or 0.0)
        height = float(item.get("height_um", 0.0) or 0.0)
        sizes[item_id] = (width, height)
    return sizes


def geometry_check(case: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    core = case.get("floorplan", {}).get("core_area_um", [0, 0, 0, 0])
    min_x, min_y, max_x, max_y = [float(value) for value in core]
    sizes = object_sizes(case)
    boxes: list[tuple[str, float, float, float, float]] = []
    unknown_targets: list[str] = []
    out_of_bounds: list[str] = []
    for change in candidate.get("proposed_changes", []):
        if not isinstance(change, dict):
            continue
        target = str(change.get("target", ""))
        object_id = target.removeprefix("placement.")
        if object_id not in sizes:
            unknown_targets.append(target)
            continue
        value = change.get("value", {})
        if not isinstance(value, dict):
            unknown_targets.append(target)
            continue
        x_um = float(value.get("x_um", 0.0))
        y_um = float(value.get("y_um", 0.0))
        width, height = sizes[object_id]
        box = (object_id, x_um, y_um, x_um + width, y_um + height)
        boxes.append(box)
        if box[1] < min_x or box[2] < min_y or box[3] > max_x or box[4] > max_y:
            out_of_bounds.append(object_id)

    overlaps: list[dict[str, Any]] = []
    for left_index, left in enumerate(boxes):
        for right in boxes[left_index + 1 :]:
            width = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
            height = max(0.0, min(left[4], right[4]) - max(left[2], right[2]))
            area = width * height
            if area > 0.0:
                overlaps.append(
                    {
                        "left": left[0],
                        "right": right[0],
                        "overlap_area_um2": round(area, 6),
                    }
                )
    return {
        "unknown_target_count": len(unknown_targets),
        "unknown_targets": unknown_targets[:20],
        "out_of_bounds_count": len(out_of_bounds),
        "out_of_bounds": out_of_bounds[:20],
        "overlap_count": len(overlaps),
        "overlaps": overlaps[:20],
    }


def replay_status(candidate: dict[str, Any], case: dict[str, Any], geometry: dict[str, Any]) -> tuple[str, list[str]]:
    blockers: list[str] = []
    if geometry["unknown_target_count"]:
        blockers.append("candidate targets missing movable objects in placement case")
    if geometry["out_of_bounds_count"]:
        blockers.append("candidate places one or more macros outside core bounds")
    if geometry["overlap_count"]:
        blockers.append("candidate has macro overlaps before legalizer replay")

    design_bundle_id = str(candidate.get("design_bundle_id", ""))
    case_claim = str(case.get("claim_boundary", ""))
    replay_command = str(case.get("replay", {}).get("deterministic_command", ""))
    if design_bundle_id.startswith("e1-generated-softmacro"):
        blockers.append("abstract E1 softmacro case must become real LEF/DEF/OpenLane macro case")
    elif design_bundle_id == "e1-softmacro-smoke-design-bundle":
        blockers.append("fixture case is schema smoke only, not a release OpenLane replay target")
    elif design_bundle_id.startswith("tilos-"):
        blockers.append("external benchmark replay requires local MacroPlacement/OpenROAD tool review")
    elif "openroad" not in replay_command.lower() and "openlane" not in replay_command.lower():
        blockers.append("placement case lacks OpenLane/OpenROAD deterministic replay command")
    if "release_claim" not in case_claim:
        blockers.append("placement case claim boundary does not explicitly forbid release claims")

    if blockers:
        return "BLOCKED_REPLAY_PLAN_READY", blockers
    return "READY_FOR_DETERMINISTIC_REPLAY", []


def write_macro_cfg(path: Path, candidate: dict[str, Any]) -> int:
    lines = [
        "# OpenLane-style macro placement override generated from an AI-EDA candidate.",
        "# Format: <instance> <x_um> <y_um> <orientation>",
        "# Quarantined artifact; do not use as evidence until replay gates pass.",
    ]
    count = 0
    for change in candidate.get("proposed_changes", []):
        if not isinstance(change, dict) or change.get("action") != "move":
            continue
        target = str(change.get("target", "")).removeprefix("placement.")
        value = change.get("value", {})
        if not target or not isinstance(value, dict):
            continue
        orient = str(value.get("orientation", "N"))
        lines.append(f"{target} {float(value['x_um']):.6f} {float(value['y_um']):.6f} {orient}")
        count += 1
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return count


def write_tool_action_manifest(
    path: Path,
    candidate_path: Path,
    case_path: Path,
    bundle_dir: Path,
    plan: dict[str, Any],
) -> None:
    blockers = list(plan["blockers"])
    if not blockers:
        blockers = ["human PD approval is still required before execution"]
    manifest = {
        "schema": "eda.tool_action.v1",
        "id": f"macro-placement-replay-{slug(plan['candidate_id'])}",
        "action_type": "pd_replay",
        "tool": "openlane",
        "mode": "dry_run",
        "claim_boundary": "macro_placement_replay_tool_action_only_no_tool_execution_source_change_or_release_claim",
        "command": {
            "argv": [
                "openlane",
                "--config",
                "pd/openlane/config.sky130.json",
            ],
            "cwd": "packages/chip",
        },
        "read_scope": [
            rel(candidate_path),
            rel(case_path),
            "pd/openlane/config.sky130.json",
        ],
        "write_scope": [rel(bundle_dir) + "/"],
        "input_artifacts": [
            {"path": rel(candidate_path), "sha256": sha256_file(candidate_path)},
            {"path": rel(case_path), "sha256": sha256_file(case_path)},
        ],
        "generated_artifacts": [
            {"path": plan["artifacts"]["macro_placement_cfg"], "kind": "macro_placement_cfg"},
            {"path": plan["artifacts"]["placement_overrides"], "kind": "placement_overrides"},
        ],
        "approval": {
            "required": True,
            "status": "not_requested_replay_blocked",
        },
        "execution": {
            "dry_run_only": True,
            "archived_stdout": rel(bundle_dir / "openlane.stdout.txt"),
            "archived_stderr": rel(bundle_dir / "openlane.stderr.txt"),
        },
        "status": {
            "result": plan["status"],
            "blockers": blockers,
        },
    }
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--candidate-dir", action="append", type=Path, default=[])
    parser.add_argument("--candidate", action="append", type=Path, default=[])
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    record_dirs = args.record_dir or list(DEFAULT_RECORD_DIRS)
    cases = load_placement_cases(record_dirs)
    candidate_dirs = args.candidate_dir or [DEFAULT_CANDIDATE_DIR]
    candidates = candidate_paths(candidate_dirs, args.candidate)
    out_dir = args.out_root / args.run_id
    bundles_dir = out_dir / "bundles"
    tool_actions_dir = out_dir / "tool_actions"
    bundles_dir.mkdir(parents=True, exist_ok=True)
    tool_actions_dir.mkdir(parents=True, exist_ok=True)

    errors: list[str] = []
    plans: list[dict[str, Any]] = []
    for candidate_path in candidates:
        candidate = load_json(candidate_path)
        candidate_id = str(candidate.get("id", candidate_path.stem))
        design_bundle_id = str(candidate.get("design_bundle_id", ""))
        case_tuple = cases.get(design_bundle_id)
        if case_tuple is None:
            errors.append(f"{candidate_id}: no placement case found for {design_bundle_id}")
            continue
        case_path, case = case_tuple
        geometry = geometry_check(case, candidate)
        status, blockers = replay_status(candidate, case, geometry)
        bundle_dir = bundles_dir / slug(candidate_id)
        bundle_dir.mkdir(parents=True, exist_ok=True)
        macro_cfg = bundle_dir / "macro_placement.cfg"
        override_count = write_macro_cfg(macro_cfg, candidate)
        placement_overrides = {
            "schema": "eliza.ai_eda.macro_placement_overrides.v1",
            "candidate_id": candidate_id,
            "design_bundle_id": design_bundle_id,
            "placement_case_id": case.get("id"),
            "claim_boundary": CLAIM_BOUNDARY,
            "overrides": candidate.get("proposed_changes", []),
        }
        overrides_path = bundle_dir / "placement_overrides.json"
        overrides_path.write_text(
            json.dumps(placement_overrides, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        plan = {
            "candidate_id": candidate_id,
            "candidate_path": rel(candidate_path),
            "candidate_sha256": sha256_file(candidate_path),
            "design_bundle_id": design_bundle_id,
            "placement_case_id": case.get("id"),
            "placement_case_path": rel(case_path),
            "placement_case_sha256": sha256_file(case_path),
            "status": status,
            "blockers": blockers,
            "geometry": geometry,
            "artifacts": {
                "bundle_dir": rel(bundle_dir),
                "macro_placement_cfg": rel(macro_cfg),
                "placement_overrides": rel(overrides_path),
                "override_count": override_count,
            },
            "deterministic_replay": {
                "candidate_schema_check": f"python3 scripts/ai_eda/check_candidate_manifests.py --candidate {rel(candidate_path)}",
                "placement_case_replay_command": case.get("replay", {}).get("deterministic_command"),
                "expected_report": case.get("replay", {}).get("expected_report"),
                "next_openlane_step": (
                    "copy macro_placement.cfg into a quarantined OpenLane run directory and set "
                    "MACRO_PLACEMENT_CFG only after the placement case has real LEF/DEF macros"
                ),
            },
        }
        tool_action_path = tool_actions_dir / f"{slug(candidate_id)}.tool-action.json"
        write_tool_action_manifest(tool_action_path, candidate_path, case_path, bundle_dir, plan)
        plan["tool_action_manifest"] = rel(tool_action_path)
        plans.append(plan)

    ready_count = sum(1 for plan in plans if plan["status"] == "READY_FOR_DETERMINISTIC_REPLAY")
    blocked_count = sum(1 for plan in plans if plan["status"].startswith("BLOCKED"))
    report = {
        "schema": "eliza.ai_eda.macro_placement_replay_plan.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "candidate_count": len(plans),
        "ready_count": ready_count,
        "blocked_count": blocked_count,
        "record_dirs": [rel(path) for path in record_dirs],
        "candidate_dirs": [rel(path) for path in candidate_dirs],
        "tool_actions_dir": rel(tool_actions_dir),
        "plans": plans,
        "errors": errors,
        "release_use_allowed": False,
    }
    report_path = out_dir / "replay_plan.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.macro_placement_replay_plan {error}")
        return 1
    status = "PASS_WITH_BLOCKED_REPLAY" if blocked_count else "PASS"
    print(
        f"STATUS: {status} ai_eda.macro_placement_replay_plan "
        f"candidates={len(plans)} ready={ready_count} blocked={blocked_count} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
