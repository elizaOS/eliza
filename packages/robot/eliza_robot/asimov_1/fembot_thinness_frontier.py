"""Thinness frontier proof for ASIMOV fembot generated envelopes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_clearance_projection import (
    build_fembot_clearance_projection_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_slimming_envelope import build_fembot_slimming_envelope_proof
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_THINNESS_FRONTIER_SCHEMA = "asimov-fembot-thinness-frontier-proof-v1"
AREA_TOLERANCE_M2 = 1e-12


def _xy_area(extents: list[float]) -> float:
    return float(extents[0]) * float(extents[1])


def _reduction_fraction(source_area: float, reduced_area: float) -> float | None:
    if source_area <= 0.0:
        return None
    return 1.0 - reduced_area / source_area


def _slimming_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        record["link"]: record
        for group in report.get("body_groups", [])
        for record in group.get("link_records", [])
    }


def _generated_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {record["link"]: record for record in report.get("link_steps", [])}


def _clearance_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {record["link"]: record for record in report.get("link_clearance", [])}


def _structural_remediation_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        record["link"]: record
        for record in report.get("structural_remediation_thinness_impact", [])
    }


def _load_component_constraints_report() -> dict[str, Any] | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-component-constraints.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _supplier_growth_by_link(report: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not report:
        return {}
    return {
        str(record.get("link")).upper(): record
        for record in report.get("vendor_envelope_summary", {}).get(
            "supplier_code_link_growth_summary",
            [],
        )
        if record.get("requires_growth")
    }


def _process_floor_active(record: dict[str, Any]) -> bool:
    for axis in record.get("axis_constraints", {}).values():
        candidate = float(axis.get("candidate_min_extent_m") or 0.0)
        process = float(axis.get("minimum_manufacturable_extent_m") or 0.0)
        if process > 0.0 and abs(candidate - process) <= 1e-9:
            return True
    return False


def _frontier_record(
    *,
    link: str,
    group: str,
    slimming: dict[str, Any],
    generated: dict[str, Any],
    clearance: dict[str, Any],
    structural_remediation: dict[str, Any] | None,
    supplier_growth: dict[str, Any] | None,
) -> dict[str, Any]:
    source_extents = [float(value) for value in slimming["source_bbox_extent_m"]]
    candidate_extents = [float(value) for value in slimming["candidate_min_bbox_extent_m"]]
    adjusted_extents = [float(value) for value in clearance["adjusted_bbox_extent_m"]]
    generated_extents = [float(value) for value in generated["reloaded_bbox_extent_m"]]
    source_area = _xy_area(source_extents)
    candidate_area = _xy_area(candidate_extents)
    adjusted_area = _xy_area(adjusted_extents)
    generated_area = _xy_area(generated_extents)
    internal_cavity = generated.get("internal_cavity") or {}
    internal_cavity_violations = int(internal_cavity.get("violation_count") or 0)
    keepout_limited = bool(
        int(clearance.get("violation_count") or 0) > 0
        or adjusted_area > candidate_area + AREA_TOLERANCE_M2
    )
    structural_limited = structural_remediation is not None
    supplier_growth_limited = bool(supplier_growth and supplier_growth.get("requires_growth"))
    supplier_growth_sorted = (
        [float(value) for value in supplier_growth.get("max_required_sorted_extent_growth_m", [])]
        if supplier_growth
        else []
    )
    supplier_adjusted_extents = sorted(generated_extents)
    if len(supplier_growth_sorted) == 3:
        supplier_adjusted_extents = [
            supplier_adjusted_extents[index] + supplier_growth_sorted[index]
            for index in range(3)
        ]
    supplier_sorted_footprint_area = supplier_adjusted_extents[0] * supplier_adjusted_extents[1]
    generated_sorted_footprint_area = _xy_area(sorted(generated_extents))
    limiters = ["z_height_preservation"]
    if keepout_limited:
        limiters.append("keepout_clearance")
    if _process_floor_active(slimming):
        limiters.append("manufacturing_process_floor")
    if internal_cavity_violations > 0:
        limiters.append("internal_cavity_keepout")
    if structural_limited:
        limiters.append("structural_safety_factor")
    if supplier_growth_limited:
        limiters.append("supplier_vendor_keepout")
    return {
        "link": link,
        "group": group,
        "source_bbox_extent_m": source_extents,
        "candidate_min_bbox_extent_m": candidate_extents,
        "clearance_adjusted_bbox_extent_m": adjusted_extents,
        "generated_bbox_extent_m": generated_extents,
        "source_xy_area_m2": source_area,
        "candidate_xy_area_m2": candidate_area,
        "clearance_adjusted_xy_area_m2": adjusted_area,
        "generated_xy_area_m2": generated_area,
        "supplier_vendor_limited": supplier_growth_limited,
        "supplier_vendor_growth": supplier_growth,
        "supplier_vendor_adjusted_sorted_extent_m": supplier_adjusted_extents,
        "supplier_vendor_adjusted_sorted_footprint_area_m2": supplier_sorted_footprint_area,
        "supplier_vendor_sorted_footprint_area_delta_m2": supplier_sorted_footprint_area
        - generated_sorted_footprint_area,
        "source_to_candidate_xy_reduction_fraction": _reduction_fraction(
            source_area,
            candidate_area,
        ),
        "source_to_clearance_adjusted_xy_reduction_fraction": _reduction_fraction(
            source_area,
            adjusted_area,
        ),
        "source_to_generated_xy_reduction_fraction": _reduction_fraction(
            source_area,
            generated_area,
        ),
        "candidate_to_clearance_adjusted_xy_area_increase_m2": adjusted_area
        - candidate_area,
        "candidate_to_generated_xy_area_delta_m2": generated_area - candidate_area,
        "z_height_preserved": bool(slimming.get("z_height_preserved"))
        and abs(generated_extents[2] - source_extents[2]) <= 1e-3,
        "protected_anchor_count": int(slimming.get("protected_anchor_count") or 0),
        "keepout_point_count": int(clearance.get("keepout_point_count") or 0),
        "keepout_limited": keepout_limited,
        "minimum_projected_clearance_m": clearance.get("minimum_projected_clearance_m"),
        "adjusted_minimum_projected_clearance_m": clearance.get(
            "adjusted_minimum_projected_clearance_m"
        ),
        "process_floor_limited": _process_floor_active(slimming),
        "internal_cavity_limited": internal_cavity_violations > 0,
        "internal_cavity_violation_count": internal_cavity_violations,
        "structural_limited": structural_limited,
        "structural_remediation": structural_remediation,
        "active_limiters": limiters,
        "accepted": False,
        "blocking_reason": (
            "thinness frontier is analytically bounded, but production acceptance "
            "still needs resolved cavity/keepout constraints, structural proof at "
            "the final envelope, collision simulation, and hardware-calibrated inertia"
        ),
    }


def build_fembot_thinness_frontier_proof(
    body_groups: list[dict[str, Any]],
    *,
    slimming_report: dict[str, Any] | None = None,
    clearance_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    structural_report: dict[str, Any] | None = None,
    component_constraint_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    slimming = slimming_report or build_fembot_slimming_envelope_proof(body_groups)
    clearance = clearance_report or build_fembot_clearance_projection_proof(body_groups)
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(
        body_groups,
        clearance_report=clearance,
    )
    structural = structural_report or build_fembot_structural_sanity_proof(
        body_groups,
        generated_cad_report=generated,
    )
    slimming_links = _slimming_by_link(slimming)
    clearance_links = _clearance_by_link(clearance)
    generated_links = _generated_by_link(generated)
    remediation_links = _structural_remediation_by_link(structural)
    supplier_growth_links = _supplier_growth_by_link(
        component_constraint_report or _load_component_constraints_report()
    )
    requested_links = {
        str(link).upper()
        for group in body_groups
        for link in group.get("links", [])
    }
    available_links = set(slimming_links) & set(clearance_links) & set(generated_links)
    missing_links = sorted(requested_links - available_links)
    records = []
    for group in body_groups:
        group_name = str(group.get("group"))
        for link in [str(link).upper() for link in group.get("links", [])]:
            if link not in slimming_links or link not in clearance_links or link not in generated_links:
                continue
            records.append(
                _frontier_record(
                    link=link,
                    group=group_name,
                    slimming=slimming_links[link],
                    generated=generated_links[link],
                    clearance=clearance_links[link],
                    structural_remediation=remediation_links.get(link),
                    supplier_growth=supplier_growth_links.get(link),
                )
            )
    limiter_counts: dict[str, int] = {}
    for record in records:
        for limiter in record["active_limiters"]:
            limiter_counts[limiter] = limiter_counts.get(limiter, 0) + 1
    source_area = sum(float(record["source_xy_area_m2"]) for record in records)
    candidate_area = sum(float(record["candidate_xy_area_m2"]) for record in records)
    adjusted_area = sum(float(record["clearance_adjusted_xy_area_m2"]) for record in records)
    generated_area = sum(float(record["generated_xy_area_m2"]) for record in records)
    supplier_adjusted_sorted_footprint_area = sum(
        float(record["supplier_vendor_adjusted_sorted_footprint_area_m2"])
        for record in records
    )
    generated_sorted_footprint_area = sum(
        _xy_area(sorted([float(value) for value in record["generated_bbox_extent_m"]]))
        for record in records
    )
    ok = bool(
        slimming.get("ok")
        and clearance.get("ok")
        and generated.get("ok")
        and structural.get("ok")
        and len(records) == 28
        and not missing_links
    )
    return {
        "schema": FEMBOT_THINNESS_FRONTIER_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "slimming_schema": slimming.get("schema"),
            "clearance_schema": clearance.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "structural_schema": structural.get("schema"),
        },
        "summary": {
            "links": len(records),
            "missing_links": missing_links,
            "source_total_xy_area_m2": source_area,
            "candidate_total_xy_area_m2": candidate_area,
            "clearance_adjusted_total_xy_area_m2": adjusted_area,
            "generated_total_xy_area_m2": generated_area,
            "generated_total_sorted_footprint_area_m2": generated_sorted_footprint_area,
            "supplier_vendor_adjusted_total_sorted_footprint_area_m2": supplier_adjusted_sorted_footprint_area,
            "supplier_vendor_sorted_footprint_area_delta_m2": supplier_adjusted_sorted_footprint_area
            - generated_sorted_footprint_area,
            "source_to_candidate_xy_reduction_fraction": _reduction_fraction(
                source_area,
                candidate_area,
            ),
            "source_to_clearance_adjusted_xy_reduction_fraction": _reduction_fraction(
                source_area,
                adjusted_area,
            ),
            "source_to_generated_xy_reduction_fraction": _reduction_fraction(
                source_area,
                generated_area,
            ),
            "height_preserved_links": sum(1 for record in records if record["z_height_preserved"]),
            "keepout_limited_links": sum(1 for record in records if record["keepout_limited"]),
            "process_floor_limited_links": sum(
                1 for record in records if record["process_floor_limited"]
            ),
            "internal_cavity_limited_links": sum(
                1 for record in records if record["internal_cavity_limited"]
            ),
            "structural_limited_links": sum(
                1 for record in records if record["structural_limited"]
            ),
            "supplier_vendor_limited_links": sum(
                1 for record in records if record["supplier_vendor_limited"]
            ),
            "supplier_vendor_worst_growth_links": [
                record["link"]
                for record in sorted(
                    (record for record in records if record["supplier_vendor_limited"]),
                    key=lambda item: (
                        -float(
                            item.get("supplier_vendor_growth", {}).get(
                                "max_required_extent_growth_m",
                                0.0,
                            )
                        ),
                        item["link"],
                    ),
                )[:8]
            ],
            "supplier_vendor_max_required_extent_growth_m": max(
                (
                    float(
                        record.get("supplier_vendor_growth", {}).get(
                            "max_required_extent_growth_m",
                            0.0,
                        )
                    )
                    for record in records
                    if record["supplier_vendor_limited"]
                ),
                default=0.0,
            ),
            "active_limiter_counts": dict(sorted(limiter_counts.items())),
            "accepted": False,
            "acceptance_blocker": (
                "thinness frontier identifies active per-link limiters, but final "
                "acceptance still requires the limiting cavity, keepout, structural, "
                "collision, inertia, and hardware-controller gates to pass at the "
                "same final envelope"
            ),
        },
        "links": records,
    }


def dump_fembot_thinness_frontier_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_thinness_frontier_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-thinness-frontier.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_thinness_frontier_proof_json(report), encoding="utf-8")
    return output
