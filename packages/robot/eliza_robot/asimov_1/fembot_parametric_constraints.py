"""Parametric constraint manifest for generated ASIMOV fembot links."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_assembly import build_fembot_assembly_proof
from eliza_robot.asimov_1.fembot_clearance_projection import (
    build_fembot_clearance_projection_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof
from eliza_robot.asimov_1.fembot_mold_dfm import build_fembot_mold_dfm_proof
from eliza_robot.asimov_1.fembot_slimming_envelope import build_fembot_slimming_envelope_proof
from eliza_robot.asimov_1.fembot_surface_quality import build_fembot_surface_quality_proof
from eliza_robot.asimov_1.fembot_thinness_frontier import build_fembot_thinness_frontier_proof
from eliza_robot.asimov_1.fembot_topology import build_fembot_topology_proof
from eliza_robot.asimov_1.fembot_topology_promotion import (
    build_fembot_topology_promotion_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_PARAMETRIC_CONSTRAINTS_SCHEMA = "asimov-fembot-parametric-constraints-v1"
DIMENSION_TOLERANCE_M = 1.0e-6


def _by_link(records: list[dict[str, Any]], *, key: str = "link") -> dict[str, dict[str, Any]]:
    return {str(record.get(key, "")).upper(): record for record in records if record.get(key)}


def _surface_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(surface.get("link", "")).upper(): surface
        for group in report.get("generated_body_groups", [])
        for surface in group.get("surfaces", [])
        if surface.get("link")
    }


def _material_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return _by_link(report.get("generated_parts", []), key="part_id")


def _mold_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return _by_link(report.get("shells", []))


def _axis_parameter_records(
    *,
    slimming: dict[str, Any],
    clearance: dict[str, Any],
    generated: dict[str, Any],
) -> list[dict[str, Any]]:
    axis_names = ("x", "y", "z")
    records: list[dict[str, Any]] = []
    for index, axis in enumerate(axis_names):
        current = float(slimming["source_bbox_extent_m"][index])
        candidate = float(slimming["candidate_min_bbox_extent_m"][index])
        adjusted = float(clearance["adjusted_bbox_extent_m"][index])
        generated_extent = float(generated["reloaded_bbox_extent_m"][index])
        records.append(
            {
                "name": f"{axis}_extent_m",
                "kind": "dimension",
                "axis": axis,
                "source_value_m": current,
                "candidate_min_value_m": candidate,
                "clearance_adjusted_value_m": adjusted,
                "generated_value_m": generated_extent,
                "generated_delta_vs_adjusted_m": generated_extent - adjusted,
                "preserve_source_value": axis == "z",
                "verified": abs(generated_extent - adjusted) <= DIMENSION_TOLERANCE_M,
                "proofs": [
                    "asimov-fembot-slimming-envelope-v1",
                    "asimov-fembot-clearance-projection-v1",
                    "asimov-fembot-generated-cad-parametric-v1",
                ],
            }
        )
    return records


def _constraint_record(
    *,
    name: str,
    kind: str,
    verified: bool,
    value: Any,
    limit: Any = None,
    proofs: list[str],
    production_blocker: str | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "value": value,
        "limit": limit,
        "verified": bool(verified),
        "proofs": proofs,
        "production_blocker": production_blocker,
    }


def _link_record(
    *,
    link: str,
    group: str,
    generated: dict[str, Any],
    slimming: dict[str, Any],
    clearance: dict[str, Any],
    material: dict[str, Any] | None,
    surface: dict[str, Any] | None,
    topology: dict[str, Any] | None,
    promoted_topology: dict[str, Any] | None,
    mold: dict[str, Any] | None,
    frontier: dict[str, Any] | None,
) -> dict[str, Any]:
    parameters = _axis_parameter_records(
        slimming=slimming,
        clearance=clearance,
        generated=generated,
    )
    wall_value = (
        generated.get("wall_thickness_m")
        if generated.get("wall_thickness_m") is not None
        else generated.get("minimum_plate_thickness_m")
    )
    topology_accepted = bool(topology and topology.get("accepted"))
    promoted_topology_accepted = bool(
        promoted_topology and promoted_topology.get("accepted")
    )
    constraints = [
        _constraint_record(
            name="z_height_preservation",
            kind="interface",
            value=frontier.get("z_height_preserved") if frontier else None,
            verified=bool(frontier and frontier.get("z_height_preserved")),
            proofs=[
                "asimov-fembot-slimming-envelope-v1",
                "asimov-fembot-thinness-frontier-proof-v1",
                "asimov-fembot-assembly-proof-v1",
            ],
        ),
        _constraint_record(
            name="keepout_clearance_adjusted",
            kind="keepout",
            value=clearance.get("adjusted_minimum_projected_clearance_m"),
            limit=0.0,
            verified=(
                clearance.get("adjusted_minimum_projected_clearance_m") is not None
                and float(clearance["adjusted_minimum_projected_clearance_m"]) >= 0.0
                and int(clearance.get("adjusted_violation_count") or 0) == 0
            ),
            proofs=["asimov-fembot-clearance-projection-v1"],
            production_blocker="point-projected clearance is not full component volume clearance",
        ),
        _constraint_record(
            name="wall_or_plate_thickness",
            kind="manufacturing",
            value=wall_value,
            limit=(material or {}).get("minimum_wall_thickness_m"),
            verified=bool(
                material
                and material.get("manufacturing_adjusted_wall_thickness_ok")
            ),
            proofs=[
                "asimov-fembot-generated-cad-parametric-v1",
                "asimov-fembot-material-manufacturing-proof-v1",
            ],
            production_blocker="exact process drawings and inspection plan still required",
        ),
        _constraint_record(
            name="surface_intent",
            kind="surface",
            value=generated.get("surface_intent"),
            verified=bool(surface and surface.get("generated_surface_check_ok")),
            proofs=["asimov-fembot-surface-quality-proof-v1"],
            production_blocker=(
                "manufactured flatness/smoothness tolerances are not yet accepted"
            ),
        ),
        _constraint_record(
            name="topology_or_repair_preview",
            kind="topology",
            value={
                "raw_generated_topology_accepted": (topology or {}).get("accepted"),
                "promoted_step_topology_accepted": (
                    promoted_topology or {}
                ).get("accepted"),
                "promoted_step_path": (promoted_topology or {}).get(
                    "promoted_step_path"
                ),
            },
            verified=topology_accepted or promoted_topology_accepted,
            proofs=[
                "asimov-fembot-topology-proof-v1",
                "asimov-fembot-topology-promotion-v1",
            ],
            production_blocker=None
            if topology_accepted or promoted_topology_accepted
            else "generated mesh topology needs repair preview promotion",
        ),
        _constraint_record(
            name="internal_cavity_clearance",
            kind="internal_keepout",
            value=(generated.get("internal_cavity") or {}).get("minimum_projected_clearance_m"),
            limit=0.0,
            verified=int((generated.get("internal_cavity") or {}).get("violation_count") or 0) == 0,
            proofs=[
                "asimov-fembot-generated-cad-parametric-v1",
                "asimov-fembot-thinness-frontier-proof-v1",
            ],
            production_blocker="internal cavity/component keepout violations remain"
            if int((generated.get("internal_cavity") or {}).get("violation_count") or 0) > 0
            else None,
        ),
    ]
    if frontier and frontier.get("supplier_vendor_limited"):
        supplier_growth = frontier.get("supplier_vendor_growth") or {}
        supplier_candidate = generated.get("supplier_vendor_adjusted_candidate") or {}
        supplier_fit = supplier_candidate.get("fit_validation") or {}
        supplier_bbox_verified = bool(
            supplier_candidate.get("required")
            and supplier_candidate.get("reload_ok")
            and supplier_candidate.get("extent_within_tolerance")
            and supplier_fit.get("all_fit")
        )
        constraints.append(
            _constraint_record(
                name="supplier_vendor_keepout_growth",
                kind="vendor_keepout",
                value={
                    "max_required_extent_growth_m": supplier_growth.get(
                        "max_required_extent_growth_m"
                    ),
                    "max_required_sorted_extent_growth_m": supplier_growth.get(
                        "max_required_sorted_extent_growth_m"
                    ),
                    "failed_supplier_codes": supplier_growth.get("failed_supplier_codes", []),
                    "fit_fail_count": supplier_growth.get("fit_fail_count"),
                    "supplier_vendor_adjusted_step_path": supplier_candidate.get("step_path"),
                    "supplier_vendor_adjusted_step_sha256": supplier_candidate.get(
                        "step_sha256"
                    ),
                    "supplier_vendor_adjusted_fit_check_count": supplier_fit.get(
                        "fit_check_count"
                    ),
                    "supplier_vendor_adjusted_fit_pass_count": supplier_fit.get(
                        "fit_pass_count"
                    ),
                    "supplier_vendor_adjusted_fit_fail_count": supplier_fit.get(
                        "fit_fail_count"
                    ),
                    "supplier_vendor_adjusted_max_residual_extent_growth_m": supplier_fit.get(
                        "max_residual_extent_growth_m"
                    ),
                },
                limit=0.0,
                verified=supplier_bbox_verified,
                proofs=[
                    "asimov-fembot-component-constraint-coverage-v1",
                    "asimov-fembot-thinness-frontier-proof-v1",
                    "asimov-fembot-generated-cad-parametric-v1",
                ],
                production_blocker=(
                    "orientation-agnostic supplier bbox preview clears measured growth, "
                    "but exact placed vendor pockets, mate features, fastener access, "
                    "and collision/structural validation are still required"
                ),
            )
        )
    full_cavity_candidate = generated.get("full_cavity_clearance_candidate") or {}
    if full_cavity_candidate.get("required"):
        constraints.append(
            _constraint_record(
                name="full_cavity_clearance_candidate",
                kind="internal_keepout",
                value={
                    "step_path": full_cavity_candidate.get("step_path"),
                    "step_sha256": full_cavity_candidate.get("step_sha256"),
                    "internal_cavity_cleared": full_cavity_candidate.get(
                        "internal_cavity_cleared"
                    ),
                    "height_preserved": full_cavity_candidate.get("height_preserved"),
                    "z_expansion_m": full_cavity_candidate.get("z_expansion_m"),
                    "strict_extent_max_abs_error_m": full_cavity_candidate.get(
                        "strict_extent_max_abs_error_m"
                    ),
                    "full_cavity_clearance_extent_tolerance_m": (
                        full_cavity_candidate.get(
                            "full_cavity_clearance_extent_tolerance_m"
                        )
                    ),
                    "full_cavity_clearance_extent_within_tolerance": (
                        full_cavity_candidate.get(
                            "full_cavity_clearance_extent_within_tolerance"
                        )
                    ),
                    "xy_area_increase_fraction": full_cavity_candidate.get(
                        "xy_area_increase_fraction"
                    ),
                    "volume_increase_fraction": full_cavity_candidate.get(
                        "volume_increase_fraction"
                    ),
                },
                limit=0.0,
                verified=bool(
                    full_cavity_candidate.get("reload_ok")
                    and full_cavity_candidate.get(
                        "full_cavity_clearance_extent_within_tolerance",
                        full_cavity_candidate.get("extent_within_tolerance"),
                    )
                    and full_cavity_candidate.get("internal_cavity_cleared")
                ),
                proofs=["asimov-fembot-generated-cad-parametric-v1"],
                production_blocker=(
                    "full-cavity clearance is parameterized, but production still "
                    "needs mate-preserving local pockets or exact component envelopes"
                ),
            )
        )
    if mold is not None:
        constraints.append(
            _constraint_record(
                name="mold_draft_or_vacuform_process",
                kind="manufacturing_dfm",
                value={
                    "injection_candidate": mold["injection_molding"]["candidate"],
                    "vacuform_candidate": mold["vacuform"]["candidate"],
                },
                verified=bool(
                    mold["injection_molding"]["candidate"]
                    or mold["vacuform"]["candidate"]
                ),
                proofs=["asimov-fembot-mold-dfm-proof-v1"],
                production_blocker="draft, undercut, split-line or trim-flange proof missing",
            )
        )
    verified_constraints = sum(1 for constraint in constraints if constraint["verified"])
    return {
        "link": link,
        "group": group,
        "shape_family": generated.get("shape_family"),
        "surface_intent": generated.get("surface_intent"),
        "generated_geometry_role": generated.get("generated_geometry_role"),
        "step_path": generated.get("step_path"),
        "parameters": parameters,
        "constraints": constraints,
        "parameter_count": len(parameters),
        "constraint_count": len(constraints),
        "verified_constraint_count": verified_constraints,
        "production_blocker_count": sum(
            1 for constraint in constraints if constraint.get("production_blocker")
        ),
        "active_thinness_limiters": frontier.get("active_limiters", []) if frontier else [],
        "accepted": False,
        "blocking_reason": (
            "parametric constraint manifest is complete for generated references, "
            "but production acceptance requires every linked proof to be accepted"
        ),
    }


def build_fembot_parametric_constraints_proof(
    body_groups: list[dict[str, Any]],
    *,
    slimming_report: dict[str, Any] | None = None,
    clearance_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    material_report: dict[str, Any] | None = None,
    surface_report: dict[str, Any] | None = None,
    topology_report: dict[str, Any] | None = None,
    topology_promotion_report: dict[str, Any] | None = None,
    assembly_report: dict[str, Any] | None = None,
    mold_dfm_report: dict[str, Any] | None = None,
    thinness_frontier_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    slimming = slimming_report or build_fembot_slimming_envelope_proof(body_groups)
    clearance = clearance_report or build_fembot_clearance_projection_proof(body_groups)
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(
        body_groups,
        clearance_report=clearance,
    )
    material = material_report or build_fembot_material_manufacturing_proof(
        body_groups,
        generated_cad_report=generated,
    )
    surface = surface_report or build_fembot_surface_quality_proof(
        body_groups,
        generated_cad_report=generated,
    )
    topology = topology_report or build_fembot_topology_proof(generated_cad_report=generated)
    topology_promotion = topology_promotion_report or build_fembot_topology_promotion_proof(
        generated_cad_report=generated,
        topology_report=topology,
    )
    mold = mold_dfm_report or build_fembot_mold_dfm_proof(
        body_groups,
        generated_cad_report=generated,
    )
    frontier = thinness_frontier_report or build_fembot_thinness_frontier_proof(
        body_groups,
        slimming_report=slimming,
        clearance_report=clearance,
        generated_cad_report=generated,
    )
    assembly = assembly_report or build_fembot_assembly_proof(
        body_groups,
        generated_cad_report=generated,
    )
    slimming_links = {
        record["link"]: record
        for group in slimming.get("body_groups", [])
        for record in group.get("link_records", [])
    }
    generated_links = _by_link(generated.get("link_steps", []))
    clearance_links = _by_link(clearance.get("link_clearance", []))
    material_links = _material_by_link(material)
    surface_links = _surface_by_link(surface)
    topology_links = _by_link(topology.get("link_topology", []))
    promoted_topology_links = _by_link(topology_promotion.get("validation", []))
    mold_links = _mold_by_link(mold)
    frontier_links = _by_link(frontier.get("links", []))
    requested_links = [
        str(link).upper()
        for group in body_groups
        for link in group.get("links", [])
    ]
    records = []
    for group in body_groups:
        group_name = str(group.get("group"))
        for link in [str(item).upper() for item in group.get("links", [])]:
            if link not in generated_links or link not in slimming_links or link not in clearance_links:
                continue
            records.append(
                _link_record(
                    link=link,
                    group=group_name,
                    generated=generated_links[link],
                    slimming=slimming_links[link],
                    clearance=clearance_links[link],
                    material=material_links.get(link),
                    surface=surface_links.get(link),
                    topology=topology_links.get(link),
                    promoted_topology=promoted_topology_links.get(link),
                    mold=mold_links.get(link),
                    frontier=frontier_links.get(link),
                )
            )
    missing_links = sorted(set(requested_links) - {record["link"] for record in records})
    ok = bool(
        len(records) == 28
        and not missing_links
        and generated.get("ok")
        and clearance.get("ok")
        and slimming.get("ok")
        and assembly.get("ok")
    )
    total_constraints = sum(record["constraint_count"] for record in records)
    verified_constraints = sum(record["verified_constraint_count"] for record in records)
    total_parameters = sum(record["parameter_count"] for record in records)
    production_blockers = sum(record["production_blocker_count"] for record in records)
    return {
        "schema": FEMBOT_PARAMETRIC_CONSTRAINTS_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "slimming_schema": slimming.get("schema"),
            "clearance_schema": clearance.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "material_schema": material.get("schema"),
            "surface_schema": surface.get("schema"),
            "topology_schema": topology.get("schema"),
            "topology_promotion_schema": topology_promotion.get("schema"),
            "assembly_schema": assembly.get("schema"),
            "mold_dfm_schema": mold.get("schema"),
            "thinness_frontier_schema": frontier.get("schema"),
        },
        "summary": {
            "links": len(records),
            "missing_links": missing_links,
            "parameters": total_parameters,
            "constraints": total_constraints,
            "verified_constraints": verified_constraints,
            "production_blockers": production_blockers,
            "dimension_parameters_per_link": 3,
            "links_with_height_preserved": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "z_height_preservation" and constraint["verified"]
                    for constraint in record["constraints"]
                )
            ),
            "links_with_keepout_adjusted_clearance": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "keepout_clearance_adjusted"
                    and constraint["verified"]
                    for constraint in record["constraints"]
                )
            ),
            "links_with_topology_accepted": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "topology_or_repair_preview"
                    and constraint["verified"]
                    for constraint in record["constraints"]
                )
            ),
            "links_with_promoted_topology_accepted": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "topology_or_repair_preview"
                    and bool(
                        (constraint.get("value") or {}).get(
                            "promoted_step_topology_accepted"
                        )
                    )
                    for constraint in record["constraints"]
                )
            ),
            "links_with_supplier_vendor_keepout_growth": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "supplier_vendor_keepout_growth"
                    for constraint in record["constraints"]
                )
            ),
            "links_with_supplier_vendor_adjusted_bbox_fit": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "supplier_vendor_keepout_growth"
                    and constraint["verified"]
                    for constraint in record["constraints"]
                )
            ),
            "supplier_vendor_adjusted_fit_fail": sum(
                int(
                    constraint["value"].get("supplier_vendor_adjusted_fit_fail_count")
                    or 0
                )
                for record in records
                for constraint in record["constraints"]
                if constraint["name"] == "supplier_vendor_keepout_growth"
            ),
            "links_with_full_cavity_clearance_candidate": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "full_cavity_clearance_candidate"
                    for constraint in record["constraints"]
                )
            ),
            "links_with_full_cavity_clearance_verified": sum(
                1
                for record in records
                if any(
                    constraint["name"] == "full_cavity_clearance_candidate"
                    and constraint["verified"]
                    for constraint in record["constraints"]
                )
            ),
            "supplier_vendor_adjusted_max_residual_extent_growth_m": max(
                (
                    float(
                        constraint["value"].get(
                            "supplier_vendor_adjusted_max_residual_extent_growth_m"
                        )
                        or 0.0
                    )
                    for record in records
                    for constraint in record["constraints"]
                    if constraint["name"] == "supplier_vendor_keepout_growth"
                ),
                default=0.0,
            ),
            "supplier_vendor_max_required_extent_growth_m": max(
                (
                    float(
                        constraint["value"].get("max_required_extent_growth_m")
                        or 0.0
                    )
                    for record in records
                    for constraint in record["constraints"]
                    if constraint["name"] == "supplier_vendor_keepout_growth"
                ),
                default=0.0,
            ),
            "accepted": False,
            "acceptance_blocker": (
                "parametric dimensions and linked constraints are inventoried for all "
                "generated fembot references, but production acceptance still requires "
                "all linked geometry, manufacturing, topology, DFM, structural, "
                "collision, inertia, and controller proofs to be accepted together"
            ),
        },
        "links": records,
    }


def dump_fembot_parametric_constraints_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_parametric_constraints_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-parametric-constraints.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_parametric_constraints_proof_json(report),
        encoding="utf-8",
    )
    return output
