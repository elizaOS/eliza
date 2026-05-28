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
MAX_INJECTION_SCREEN_DRAW_RATIO = 8.0
INJECTION_MIN_DRAFT_DEG = 1.5
VACUFORM_MIN_DRAFT_DEG = 3.0


def _draw_ratio(extents: list[float]) -> float:
    ordered = sorted((float(value) for value in extents if float(value) > 0.0), reverse=True)
    if len(ordered) < 2 or ordered[-1] <= 0.0:
        return float("inf")
    return ordered[0] / ordered[-1]


def _recommended_process(*, group: str, shape_family: str) -> str:
    if group in {"torso", "head"}:
        return "molded_shell_candidate_needs_draft_split_and_parting_proof"
    if group in {"arm", "leg"} or "limb" in shape_family:
        return "split_structural_shell_or_additive_reference_before_production"
    return "smooth_shell_reference_needs_process_selection"


def _wall_adjustment_preview(
    *,
    wall: float,
    cavity_minimum_clearance_m: float | None,
) -> dict[str, Any]:
    wall_increase_m = max(INJECTION_MIN_WALL_M - wall, 0.0)
    adjusted_wall_m = wall + wall_increase_m
    cavity_after_inward = (
        cavity_minimum_clearance_m - (2.0 * wall_increase_m)
        if cavity_minimum_clearance_m is not None
        else None
    )
    return {
        "source": "parametric_shell_wall_thickness_preview",
        "target_process": "injection_molding",
        "current_wall_m": wall,
        "target_wall_m": INJECTION_MIN_WALL_M,
        "wall_increase_m": wall_increase_m,
        "adjusted_wall_m": adjusted_wall_m,
        "adjusted_wall_ok": adjusted_wall_m >= INJECTION_MIN_WALL_M,
        "outer_envelope_preserving_strategy": "increase wall inward from existing loft",
        "outer_envelope_growth_if_outward_m": 2.0 * wall_increase_m,
        "inner_cavity_clearance_loss_if_inward_m": 2.0 * wall_increase_m,
        "internal_cavity_minimum_projected_clearance_after_inward_m": (
            cavity_after_inward
        ),
        "internal_cavity_clearance_ok_after_inward": bool(
            cavity_after_inward is not None and cavity_after_inward >= 0.0
        ),
        "height_preserved": True,
        "parametric_editable": True,
        "accepted": False,
        "blocking_reason": (
            "wall thickening can be represented by the shell wall_thickness_m "
            "parameter, but production still needs draft, split-line/trim features, "
            "and revalidated cavity, collision, and structural proofs after process edits"
        ),
    }


def _dfm_record(record: dict[str, Any]) -> dict[str, Any]:
    extents = [float(value) for value in record.get("reloaded_bbox_extent_m", [])]
    wall = float(record.get("wall_thickness_m") or 0.0)
    cavity = record.get("internal_cavity") or {}
    pre_clearance_cavity_violations = int(cavity.get("violation_count") or 0)
    full_clearance = record.get("full_cavity_clearance_candidate") or {}
    full_clearance_cavity = full_clearance.get("internal_cavity") or {}
    full_clearance_verified = bool(
        full_clearance.get("required")
        and full_clearance.get("reload_ok")
        and full_clearance.get("internal_cavity_cleared")
    )
    active_cavity_violations = (
        int(full_clearance_cavity.get("violation_count") or 0)
        if full_clearance_verified
        else pre_clearance_cavity_violations
    )
    draw_ratio = _draw_ratio(extents)
    injection_wall_ok = wall >= INJECTION_MIN_WALL_M
    vacuform_wall_ok = wall >= VACUFORM_MIN_WALL_M
    injection_draw_ok = draw_ratio <= MAX_INJECTION_SCREEN_DRAW_RATIO
    vacuform_draw_ok = draw_ratio <= MAX_VACUFORM_DRAW_RATIO
    split_line_candidate = record.get("surface_intent") == "smooth"
    trim_flange_candidate = record["group"] in {"torso", "head"}
    decorative_cutout_free = "cutout" in str(record.get("cutout_policy") or "").lower()
    smooth_chest_no_cutout = bool(record.get("smooth_chest_no_cutout_loft"))
    cavity_minimum_clearance = (
        full_clearance_cavity.get("minimum_projected_clearance_m")
        if full_clearance_verified
        else cavity.get("minimum_projected_clearance_m")
    )
    cavity_minimum_clearance_m = (
        float(cavity_minimum_clearance)
        if cavity_minimum_clearance is not None
        else None
    )
    wall_adjustment_preview = _wall_adjustment_preview(
        wall=wall,
        cavity_minimum_clearance_m=cavity_minimum_clearance_m,
    )
    draft_proven = False
    undercut_proven = False
    split_line_proven = False
    cavity_clearance_ok = active_cavity_violations == 0
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
        "injection_wall_shortfall_m": max(INJECTION_MIN_WALL_M - wall, 0.0),
        "vacuform_wall_shortfall_m": max(VACUFORM_MIN_WALL_M - wall, 0.0),
        "bbox_extent_m": extents,
        "draw_ratio": draw_ratio,
        "cutout_policy": record.get("cutout_policy"),
        "decorative_cutout_free": decorative_cutout_free,
        "smooth_chest_no_cutout_loft": smooth_chest_no_cutout,
        "internal_cavity_violation_count": active_cavity_violations,
        "internal_cavity_pre_clearance_violation_count": pre_clearance_cavity_violations,
        "full_cavity_clearance_verified": full_clearance_verified,
        "internal_cavity_minimum_projected_clearance_m": cavity_minimum_clearance_m,
        "injection_wall_adjustment_preview": wall_adjustment_preview,
        "injection_molding": {
            "minimum_wall_m": INJECTION_MIN_WALL_M,
            "minimum_draft_deg": INJECTION_MIN_DRAFT_DEG,
            "max_screen_draw_ratio": MAX_INJECTION_SCREEN_DRAW_RATIO,
            "wall_ok": injection_wall_ok,
            "draw_ratio_screen_ok": injection_draw_ok,
            "draft_proven": draft_proven,
            "undercut_proven": undercut_proven,
            "split_line_candidate": split_line_candidate,
            "split_line_proven": split_line_proven,
            "decorative_cutout_free": decorative_cutout_free,
            "cavity_clearance_ok": cavity_clearance_ok,
            "candidate": bool(
                injection_wall_ok
                and injection_draw_ok
                and draft_proven
                and undercut_proven
                and split_line_proven
                and cavity_clearance_ok
            ),
        },
        "vacuform": {
            "minimum_wall_m": VACUFORM_MIN_WALL_M,
            "minimum_draft_deg": VACUFORM_MIN_DRAFT_DEG,
            "max_draw_ratio": MAX_VACUFORM_DRAW_RATIO,
            "wall_ok": vacuform_wall_ok,
            "draw_ratio_ok": vacuform_draw_ok,
            "single_sided_pull_proven": draft_proven and undercut_proven,
            "trim_flange_candidate": trim_flange_candidate,
            "trim_flange_proven": False,
            "decorative_cutout_free": decorative_cutout_free,
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
            "parting features, and cavity/collision/structural revalidation for the "
            "selected process"
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
    injection_draw_failures = [
        record for record in records if not record["injection_molding"]["draw_ratio_screen_ok"]
    ]
    vacuform_draw_failures = [
        record for record in records if not record["vacuform"]["draw_ratio_ok"]
    ]
    injection_wall_adjustment_previews = [
        record["injection_wall_adjustment_preview"]
        for record in records
        if record["injection_wall_adjustment_preview"]["wall_increase_m"] > 0.0
    ]
    cavity_failures = [
        record
        for record in records
        if int(record["internal_cavity_violation_count"]) > 0
    ]
    pre_clearance_cavity_failures = [
        record
        for record in records
        if int(record["internal_cavity_pre_clearance_violation_count"]) > 0
    ]
    full_cavity_clearance_verified = [
        record for record in records if record["full_cavity_clearance_verified"]
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
            "max_injection_screen_draw_ratio": MAX_INJECTION_SCREEN_DRAW_RATIO,
            "max_vacuform_draw_ratio": MAX_VACUFORM_DRAW_RATIO,
            "injection_min_draft_deg": INJECTION_MIN_DRAFT_DEG,
            "vacuform_min_draft_deg": VACUFORM_MIN_DRAFT_DEG,
            "injection_wall_failures": len(injection_wall_failures),
            "injection_wall_adjustment_preview_shells": len(
                injection_wall_adjustment_previews
            ),
            "injection_wall_adjustment_preview_wall_ok_shells": sum(
                1
                for preview in injection_wall_adjustment_previews
                if preview["adjusted_wall_ok"]
            ),
            "injection_wall_adjustment_preview_height_preserved_shells": sum(
                1
                for preview in injection_wall_adjustment_previews
                if preview["height_preserved"]
            ),
            "injection_wall_adjustment_preview_parametric_editable_shells": sum(
                1
                for preview in injection_wall_adjustment_previews
                if preview["parametric_editable"]
            ),
            "injection_wall_adjustment_preview_cavity_clearance_failures": sum(
                1
                for preview in injection_wall_adjustment_previews
                if not preview["internal_cavity_clearance_ok_after_inward"]
            ),
            "injection_wall_adjustment_max_wall_increase_m": max(
                (
                    preview["wall_increase_m"]
                    for preview in injection_wall_adjustment_previews
                ),
                default=0.0,
            ),
            "injection_wall_adjustment_max_outward_growth_if_used_m": max(
                (
                    preview["outer_envelope_growth_if_outward_m"]
                    for preview in injection_wall_adjustment_previews
                ),
                default=0.0,
            ),
            "injection_draw_ratio_screen_failures": len(injection_draw_failures),
            "vacuform_draw_ratio_failures": len(vacuform_draw_failures),
            "internal_cavity_clearance_failures": len(cavity_failures),
            "internal_cavity_pre_clearance_failures": len(pre_clearance_cavity_failures),
            "full_cavity_clearance_verified_shells": len(full_cavity_clearance_verified),
            "split_line_candidate_shells": sum(
                1 for record in records if record["injection_molding"]["split_line_candidate"]
            ),
            "trim_flange_candidate_shells": sum(
                1 for record in records if record["vacuform"]["trim_flange_candidate"]
            ),
            "decorative_cutout_free_shells": sum(
                1 for record in records if record["decorative_cutout_free"]
            ),
            "smooth_chest_no_cutout_loft_links": sorted(
                record["link"]
                for record in records
                if record["smooth_chest_no_cutout_loft"]
            ),
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
                "trim-flange proof plus process-specific cavity, collision, and "
                "structural revalidation"
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
