"""Cavity and keepout resolution plan for source-fitted ASIMOV fembot links."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_thinness_frontier import build_fembot_thinness_frontier_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_CAVITY_RESOLUTION_SCHEMA = "asimov-fembot-cavity-resolution-plan-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _generated_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(record.get("link")).upper(): record for record in report.get("link_steps", [])}


def _frontier_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(record.get("link")).upper(): record for record in report.get("links", [])}


def _component_counts(points: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for point in points:
        component_type = str(point.get("component_type") or "unknown")
        counts[component_type] = counts.get(component_type, 0) + 1
    return dict(sorted(counts.items()))


def _resolution_strategy(
    *,
    violation_points: list[dict[str, Any]],
    full_clearance: dict[str, Any],
) -> str:
    if not violation_points:
        return "already_clear"
    if not full_clearance.get("internal_cavity_cleared"):
        return "unresolved_geometry_or_keepout"
    if full_clearance.get("height_preserved"):
        return "height_preserving_full_cavity_clearance"
    return "component_or_packaging_redesign_required_for_height_preservation"


def _link_record(
    *,
    link: str,
    generated: dict[str, Any],
    frontier: dict[str, Any] | None,
) -> dict[str, Any]:
    cavity = generated.get("internal_cavity") or {}
    violation_points = [
        point for point in cavity.get("points", []) if point.get("violates_internal_cavity")
    ]
    full_clearance = generated.get("full_cavity_clearance_candidate") or {}
    strategy = _resolution_strategy(
        violation_points=violation_points,
        full_clearance=full_clearance,
    )
    return {
        "link": link,
        "group": generated.get("group"),
        "shape_family": generated.get("shape_family"),
        "source_fitted": generated.get("shape_family") == "source_fitted_controlled_loft",
        "internal_cavity_required": bool(cavity.get("required")),
        "internal_cavity_violation_count": len(violation_points),
        "internal_cavity_violation_component_counts": _component_counts(violation_points),
        "minimum_projected_clearance_m": cavity.get("minimum_projected_clearance_m"),
        "full_cavity_clearance_required": bool(full_clearance.get("required")),
        "full_cavity_clearance_cleared": bool(
            full_clearance.get("internal_cavity_cleared")
        ),
        "full_cavity_height_preserved": bool(full_clearance.get("height_preserved")),
        "full_cavity_z_expansion_m": full_clearance.get("z_expansion_m"),
        "full_cavity_xy_area_increase_fraction": full_clearance.get(
            "xy_area_increase_fraction"
        ),
        "full_cavity_volume_increase_fraction": full_clearance.get(
            "volume_increase_fraction"
        ),
        "active_thinness_limiters": frontier.get("active_limiters", []) if frontier else [],
        "supplier_vendor_limited": bool(frontier and frontier.get("supplier_vendor_limited")),
        "resolution_strategy": strategy,
        "height_preserving_resolution_ready": strategy
        == "height_preserving_full_cavity_clearance",
        "requires_component_or_packaging_redesign": strategy
        == "component_or_packaging_redesign_required_for_height_preservation",
        "accepted": False,
    }


def build_fembot_cavity_resolution_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    thinness_frontier_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    thinness = (
        thinness_frontier_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-thinness-frontier.json")
        or build_fembot_thinness_frontier_proof(body_groups, generated_cad_report=generated)
    )
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    generated_links = _generated_by_link(generated)
    frontier_links = _frontier_by_link(thinness)
    missing_links = sorted(set(requested_links) - set(generated_links))
    records = [
        _link_record(
            link=link,
            generated=generated_links[link],
            frontier=frontier_links.get(link),
        )
        for link in requested_links
        if link in generated_links
    ]
    violating_records = [
        record for record in records if int(record["internal_cavity_violation_count"]) > 0
    ]
    component_counts: dict[str, int] = {}
    for record in violating_records:
        for component_type, count in record["internal_cavity_violation_component_counts"].items():
            component_counts[component_type] = component_counts.get(component_type, 0) + count
    height_preserving = [
        record for record in violating_records if record["height_preserving_resolution_ready"]
    ]
    redesign_required = [
        record
        for record in violating_records
        if record["requires_component_or_packaging_redesign"]
    ]
    unresolved = [
        record
        for record in violating_records
        if record["resolution_strategy"] == "unresolved_geometry_or_keepout"
    ]
    ok = bool(
        generated.get("ok")
        and thinness.get("ok")
        and len(records) == len(requested_links) == 28
        and not missing_links
        and all(record["source_fitted"] for record in records)
        and not unresolved
    )
    return {
        "schema": FEMBOT_CAVITY_RESOLUTION_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "thinness_frontier_schema": thinness.get("schema"),
        },
        "summary": {
            "links": len(records),
            "missing_links": missing_links,
            "source_fitted_links": sum(1 for record in records if record["source_fitted"]),
            "internal_cavity_violation_links": len(violating_records),
            "internal_cavity_violation_points": sum(
                int(record["internal_cavity_violation_count"])
                for record in violating_records
            ),
            "internal_cavity_violation_component_counts": dict(
                sorted(component_counts.items())
            ),
            "full_cavity_clearance_cleared_links": sum(
                1 for record in violating_records if record["full_cavity_clearance_cleared"]
            ),
            "height_preserving_resolution_links": len(height_preserving),
            "height_preserving_resolution_link_names": [
                record["link"] for record in height_preserving
            ],
            "component_or_packaging_redesign_required_links": len(redesign_required),
            "component_or_packaging_redesign_required_link_names": [
                record["link"] for record in redesign_required
            ],
            "unresolved_geometry_or_keepout_links": len(unresolved),
            "unresolved_geometry_or_keepout_link_names": [
                record["link"] for record in unresolved
            ],
            "accepted": False,
            "acceptance_blocker": (
                "cavity clearance is classified for all source-fitted links, but "
                "16 links still require component/package redesign to preserve "
                "robot height while clearing actuator, joint, and collision keepouts"
            ),
        },
        "links": records,
    }


def dump_fembot_cavity_resolution_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_cavity_resolution_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-cavity-resolution.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_cavity_resolution_proof_json(report), encoding="utf-8")
    return output
