"""Molded-shell DFM screen for ASIMOV fembot smooth loft references."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_MOLD_DFM_SCHEMA = "asimov-fembot-mold-dfm-proof-v1"
INJECTION_MIN_WALL_M = 0.0015
VACUFORM_MIN_WALL_M = 0.00075
MAX_VACUFORM_DRAW_RATIO = 3.0


def _draw_ratio(extents: list[float]) -> float:
    ordered = sorted((float(value) for value in extents if float(value) > 0.0), reverse=True)
    if len(ordered) < 2 or ordered[-1] <= 0.0:
        return float("inf")
    return ordered[0] / ordered[-1]


def _recommended_process(*, group: str, shape_family: str) -> str:
    if group in {"torso", "head"}:
        return "molded_shell_candidate_needs_draft_split_and_keepout_resolution"
    if "limb" in shape_family:
        return "split_structural_shell_or_additive_reference_before_production"
    return "smooth_shell_reference_needs_process_selection"


def _dfm_record(record: dict[str, Any]) -> dict[str, Any]:
    extents = [float(value) for value in record.get("reloaded_bbox_extent_m", [])]
    wall = float(record.get("wall_thickness_m") or 0.0)
    cavity = record.get("internal_cavity") or {}
    cavity_violations = int(cavity.get("violation_count") or 0)
    draw_ratio = _draw_ratio(extents)
    injection_wall_ok = wall >= INJECTION_MIN_WALL_M
    vacuform_wall_ok = wall >= VACUFORM_MIN_WALL_M
    vacuform_draw_ok = draw_ratio <= MAX_VACUFORM_DRAW_RATIO
    draft_proven = False
    undercut_proven = False
    split_line_proven = False
    cavity_clearance_ok = cavity_violations == 0
    return {
        "link": record["link"],
        "group": record["group"],
        "shape_family": record["shape_family"],
        "surface_intent": record["surface_intent"],
        "recommended_process": _recommended_process(
            group=str(record["group"]),
            shape_family=str(record["shape_family"]),
        ),
        "wall_thickness_m": wall,
        "bbox_extent_m": extents,
        "draw_ratio": draw_ratio,
        "internal_cavity_violation_count": cavity_violations,
        "internal_cavity_minimum_projected_clearance_m": cavity.get(
            "minimum_projected_clearance_m"
        ),
        "injection_molding": {
            "minimum_wall_m": INJECTION_MIN_WALL_M,
            "wall_ok": injection_wall_ok,
            "draft_proven": draft_proven,
            "undercut_proven": undercut_proven,
            "split_line_proven": split_line_proven,
            "cavity_clearance_ok": cavity_clearance_ok,
            "candidate": bool(
                injection_wall_ok
                and draft_proven
                and undercut_proven
                and split_line_proven
                and cavity_clearance_ok
            ),
        },
        "vacuform": {
            "minimum_wall_m": VACUFORM_MIN_WALL_M,
            "max_draw_ratio": MAX_VACUFORM_DRAW_RATIO,
            "wall_ok": vacuform_wall_ok,
            "draw_ratio_ok": vacuform_draw_ok,
            "single_sided_pull_proven": draft_proven and undercut_proven,
            "trim_flange_proven": False,
            "candidate": bool(
                vacuform_wall_ok
                and vacuform_draw_ok
                and draft_proven
                and undercut_proven
                and cavity_clearance_ok
            ),
        },
        "accepted": False,
        "blocking_reason": (
            "smooth loft has a generated shell reference, but production molding "
            "still needs explicit draft analysis, undercut/split-line proof, trim or "
            "parting features, and resolved internal keepout/cavity clearance"
        ),
    }


def build_fembot_mold_dfm_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    records = [
        _dfm_record(record)
        for record in generated.get("link_steps", [])
        if record.get("surface_intent") == "smooth"
    ]
    injection_wall_failures = [
        record
        for record in records
        if not record["injection_molding"]["wall_ok"]
    ]
    vacuform_draw_failures = [
        record for record in records if not record["vacuform"]["draw_ratio_ok"]
    ]
    cavity_failures = [
        record
        for record in records
        if int(record["internal_cavity_violation_count"]) > 0
    ]
    torso_head = [record for record in records if record["group"] in {"torso", "head"}]
    limb = [record for record in records if record["group"] in {"arm", "leg"}]
    ok = bool(generated.get("ok") and len(records) == 26)
    return {
        "schema": FEMBOT_MOLD_DFM_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "generated_cad_schema": generated.get("schema"),
        },
        "summary": {
            "smooth_shell_records": len(records),
            "torso_head_shell_records": len(torso_head),
            "limb_shell_records": len(limb),
            "injection_min_wall_m": INJECTION_MIN_WALL_M,
            "vacuform_min_wall_m": VACUFORM_MIN_WALL_M,
            "max_vacuform_draw_ratio": MAX_VACUFORM_DRAW_RATIO,
            "injection_wall_failures": len(injection_wall_failures),
            "vacuform_draw_ratio_failures": len(vacuform_draw_failures),
            "internal_cavity_clearance_failures": len(cavity_failures),
            "draft_proven_shells": 0,
            "undercut_proven_shells": 0,
            "split_line_proven_shells": 0,
            "injection_candidate_shells": sum(
                1 for record in records if record["injection_molding"]["candidate"]
            ),
            "vacuform_candidate_shells": sum(
                1 for record in records if record["vacuform"]["candidate"]
            ),
            "accepted": False,
            "acceptance_blocker": (
                "smooth shell references are classified for injection/vacuform DFM, "
                "but production acceptance still needs draft, undercut, split-line or "
                "trim-flange proof and resolved internal keepout clearance"
            ),
        },
        "shells": records,
    }


def dump_fembot_mold_dfm_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mold_dfm_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mold-dfm.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_mold_dfm_proof_json(report), encoding="utf-8")
    return output
