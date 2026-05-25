"""Parametric-source readiness proof for the ASIMOV fembot target.

Generated STL meshes are allowed as downstream MuJoCo/physics artifacts. Source
STL meshes are allowed only as reverse-engineering inputs; every generated
physics mesh must trace back to a parametric loft/STEP source and clean mesh
artifact proof.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_cad_primitive_mjcf import (
    build_fembot_cad_primitive_mjcf_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import (
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_mesh_traceability import (
    build_fembot_mesh_parametric_traceability_proof,
)
from eliza_robot.asimov_1.fembot_mjcf import FEMBOT_MJCF_PATH
from eliza_robot.asimov_1.fembot_topology import build_fembot_topology_proof
from eliza_robot.asimov_1.fembot_topology_promotion import (
    build_fembot_topology_promotion_proof,
)
from eliza_robot.asimov_1.fembot_waist_yaw_no_cutout import build_waist_yaw_no_cutout_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_ALL_CAD_READINESS_SCHEMA = "asimov-fembot-all-cad-readiness-v1"
PARAMETRIC_PARTS_ROOT = (
    Path(__file__).resolve().parents[2] / "cad" / "asimov-feminine" / "param" / "parts"
)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _link_from_mesh_file(file_name: str) -> str:
    return Path(file_name).stem.upper()


def _mesh_assets_by_name(root: ET.Element) -> dict[str, dict[str, Any]]:
    records = {}
    for mesh in root.findall(".//asset/mesh"):
        name = str(mesh.get("name") or "")
        file_name = str(mesh.get("file") or "")
        if not name or not file_name:
            continue
        records[name] = {
            "asset_name": name,
            "file": file_name,
            "link": _link_from_mesh_file(file_name),
            "uses_stl": file_name.lower().endswith(".stl"),
        }
    return records


def _mesh_visual_geoms(root: ET.Element) -> list[dict[str, Any]]:
    mesh_assets = _mesh_assets_by_name(root)
    records = []
    for geom in root.findall(".//geom"):
        if geom.get("type") != "mesh":
            continue
        mesh_name = str(geom.get("mesh") or "")
        asset = mesh_assets.get(mesh_name, {})
        records.append(
            {
                "geom": geom.get("name"),
                "mesh": mesh_name,
                "class": geom.get("class"),
                "file": asset.get("file"),
                "link": asset.get("link"),
                "uses_stl": bool(asset.get("uses_stl")),
            }
        )
    return records


def _generated_step_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("link_steps", [])
        if record.get("link")
    }


def _parametric_part_scripts_by_link(requested_links: list[str]) -> dict[str, dict[str, Any]]:
    scripts: dict[str, dict[str, Any]] = {}
    for link in requested_links:
        path = PARAMETRIC_PARTS_ROOT / f"{link}.py"
        scripts[link] = {
            "link": link,
            "path": str(path),
            "exists": path.is_file(),
            "uses_parametric_python": path.is_file(),
            "is_stl_source": False,
        }
    return scripts


def build_fembot_all_cad_readiness_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    cad_primitive_mjcf_report: dict[str, Any] | None = None,
    fembot_mjcf_report: dict[str, Any] | None = None,
    mesh_traceability_report: dict[str, Any] | None = None,
    topology_report: dict[str, Any] | None = None,
    topology_promotion_report: dict[str, Any] | None = None,
    waist_yaw_no_cutout_report: dict[str, Any] | None = None,
    source_decision_report: dict[str, Any] | None = None,
    brep_surface_fit_report: dict[str, Any] | None = None,
    link_source_assignment_report: dict[str, Any] | None = None,
    mjcf_path: Path = FEMBOT_MJCF_PATH,
    source_mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    primitive_mjcf = (
        cad_primitive_mjcf_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-cad-primitive-mjcf.json")
        or build_fembot_cad_primitive_mjcf_proof(
            body_groups,
            generated_cad_report=generated,
        )
    )
    fembot_mjcf = fembot_mjcf_report or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mjcf.json") or {}
    mesh_traceability = (
        mesh_traceability_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mesh-parametric-traceability.json")
        or build_fembot_mesh_parametric_traceability_proof()
    )
    topology = (
        topology_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-topology.json")
        or build_fembot_topology_proof(generated_cad_report=generated)
    )
    topology_promotion = (
        topology_promotion_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-topology-promotion.json")
        or build_fembot_topology_promotion_proof(
            generated_cad_report=generated,
            topology_report=topology,
        )
    )
    source_decision = source_decision_report or _load_json(
        ASIMOV_PARAM_PROOFS / "fembot-source-decision.json"
    ) or {}
    brep_surface_fit = brep_surface_fit_report or _load_json(
        ASIMOV_PARAM_PROOFS / "fembot-brep-surface-fit.json"
    ) or {}
    link_source_assignment = link_source_assignment_report or _load_json(
        ASIMOV_PARAM_PROOFS / "fembot-link-source-assignments.json"
    ) or {}
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    generated_steps = _generated_step_by_link(generated)
    generated_placeholder_links = sorted(
        link
        for link, record in generated_steps.items()
        if str(record.get("shape_family") or "").endswith("_reference")
        or str(record.get("shape_family") or "") == "flat_plate_envelope"
        or str(record.get("parametric_source") or "").startswith("cadquery_")
    )
    generated_source_fitted_loft_links = sorted(
        link
        for link, record in generated_steps.items()
        if record.get("shape_family") == "source_fitted_controlled_loft"
        and record.get("generated_geometry_role") == "source_fitted_controlled_loft_brep"
    )
    parametric_part_scripts = _parametric_part_scripts_by_link(requested_links)
    waist_yaw_no_cutout = waist_yaw_no_cutout_report or _load_json(
        ASIMOV_PARAM_PROOFS / "waist-yaw-no-cutout.json"
    )
    if waist_yaw_no_cutout is None:
        try:
            waist_yaw_no_cutout = build_waist_yaw_no_cutout_proof()
        except Exception as exc:
            waist_yaw_no_cutout = {
                "schema": "asimov-fembot-waist-yaw-no-cutout-proof-v1",
                "accepted": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

    mjcf_load_error = None
    mesh_assets: dict[str, dict[str, Any]] = {}
    mesh_visual_geoms: list[dict[str, Any]] = []
    try:
        root = ET.parse(mjcf_path).getroot()
        mesh_assets = _mesh_assets_by_name(root)
        mesh_visual_geoms = _mesh_visual_geoms(root)
    except Exception as exc:
        mjcf_load_error = f"{type(exc).__name__}: {exc}"

    asset_records = []
    for asset in sorted(mesh_assets.values(), key=lambda item: str(item["asset_name"])):
        link = str(asset.get("link") or "").upper()
        generated_record = generated_steps.get(link)
        step_path = generated_record.get("step_path") if generated_record else None
        asset_records.append(
            {
                **asset,
                "generated_step_path": step_path,
                "generated_step_sha256": (
                    generated_record.get("step_sha256") if generated_record else None
                ),
                "generated_step_export_ok": bool(
                    generated_record and generated_record.get("export_ok")
                ),
                "generated_step_reload_ok": bool(
                    generated_record and generated_record.get("reload_ok")
                ),
                "generated_step_extent_within_tolerance": bool(
                    generated_record and generated_record.get("extent_within_tolerance")
                ),
                "all_cad_blocker": (
                    "MJCF presentation references an STL mesh that is not proven as "
                    "a generated parametric physics artifact"
                )
                if asset.get("uses_stl")
                and link
                not in {
                    str(record.get("link", "")).upper()
                    for record in mesh_traceability.get("records", [])
                    if record.get("generated_stl_physics_ready")
                }
                else None,
            }
        )

    links_with_generated_steps = {
        link
        for link in requested_links
        if (record := generated_steps.get(link))
        and record.get("step_path")
        and record.get("export_ok")
        and record.get("reload_ok")
        and record.get("extent_within_tolerance")
    }
    stl_asset_links = {
        str(record.get("link", "")).upper()
        for record in asset_records
        if record.get("uses_stl") and record.get("link")
    }
    primary_visual_replacements = [
        record
        for record in fembot_mjcf.get("primary_visual_mesh_replacement", {}).get(
            "replacements", []
        )
        if record.get("replaced") and record.get("link")
    ]
    primary_replacement_links = {
        str(record.get("link", "")).upper()
        for record in primary_visual_replacements
    }
    missing_generated_step_links = sorted(set(requested_links) - links_with_generated_steps)
    missing_parametric_part_scripts = sorted(
        link
        for link in requested_links
        if not parametric_part_scripts.get(link, {}).get("exists")
    )
    mjcf_link_coverage = {
        str(record.get("link", "")).upper()
        for record in asset_records
        if record.get("link")
    } | primary_replacement_links
    missing_mjcf_asset_links = sorted(set(requested_links) - mjcf_link_coverage)
    stl_visual_geoms = [record for record in mesh_visual_geoms if record["uses_stl"]]
    generated_stl_physics_ready_links = {
        str(record.get("link", "")).upper()
        for record in mesh_traceability.get("records", [])
        if record.get("generated_stl_physics_ready")
    }
    unproven_stl_asset_links = sorted(stl_asset_links - generated_stl_physics_ready_links)
    stl_mesh_assets_have_parametric_provenance = bool(
        not stl_asset_links or not unproven_stl_asset_links
    )
    primary_no_stl_mesh_assets = not stl_asset_links and not stl_visual_geoms
    primary_replacement_ok = bool(
        fembot_mjcf.get("ok")
        and fembot_mjcf.get("summary", {}).get("no_stl_mesh_assets")
        and fembot_mjcf.get("summary", {}).get("primary_visual_mesh_replacement_ok")
        and len(primary_replacement_links) == len(requested_links)
    )
    ok = bool(
        generated.get("ok")
        and mjcf_load_error is None
        and len(requested_links) == 28
        and len(links_with_generated_steps) == len(requested_links)
        and not missing_mjcf_asset_links
    )
    generated_stl_physics_ready = bool(mesh_traceability.get("summary", {}).get(
        "generated_stl_physics_ready"
    ))
    generated_step_mesh_topology_ready = bool(topology.get("accepted"))
    promoted_step_mesh_topology_ready = bool(topology_promotion.get("accepted"))
    exact_brep_ready_links = int(
        source_decision.get("summary", {}).get("exact_brep_ready_links") or 0
    )
    accepted_brep_surface_fit_links = int(
        brep_surface_fit.get("summary", {}).get("accepted_link_fits") or 0
    )
    source_shape_ready_links = len(
        set(generated_source_fitted_loft_links)
        | (
            set(requested_links)
            if exact_brep_ready_links == len(requested_links)
            and accepted_brep_surface_fit_links == len(requested_links)
            else set()
        )
    )
    exact_source_shape_ready = bool(
        source_shape_ready_links == len(requested_links)
        and not generated_placeholder_links
    )
    physics_mesh_policy_ok = bool(
        generated_stl_physics_ready and stl_mesh_assets_have_parametric_provenance
    )
    accepted = bool(
        ok
        and physics_mesh_policy_ok
        and promoted_step_mesh_topology_ready
        and exact_source_shape_ready
        and generated.get("accepted")
    )
    generated_summary = generated.get("summary", {})
    blocker_reasons = []
    if generated_placeholder_links:
        blocker_reasons.append(
            f"{len(generated_placeholder_links)} generated links are still placeholder/reference "
            "geometry and must be replaced with source-fitted lofts or exact B-rep-derived parts"
        )
    if not exact_source_shape_ready:
        blocker_reasons.append(
            "source-shape fit is not ready across all requested links"
        )
    if not bool(generated.get("accepted")):
        blocker_reasons.append(
            "the generated CAD proof is not production-accepted yet; remaining work includes "
            "mate features, material/process checks, structural proof, internal cavity/keepout "
            "resolution, and collision validation"
        )
    return {
        "schema": FEMBOT_ALL_CAD_READINESS_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "cad_primitive_mjcf_schema": primitive_mjcf.get("schema"),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "mjcf": str(mjcf_path),
            "source_mjcf": str(source_mjcf_path),
        },
        "summary": {
            "links": len(requested_links),
            "links_with_generated_step_reference": len(links_with_generated_steps),
            "generated_placeholder_reference_links": len(generated_placeholder_links),
            "generated_placeholder_reference_link_names": generated_placeholder_links,
            "generated_source_fitted_controlled_loft_links": len(
                generated_source_fitted_loft_links
            ),
            "generated_source_fitted_controlled_loft_link_names": (
                generated_source_fitted_loft_links
            ),
            "source_shape_ready_links": source_shape_ready_links,
            "source_decision_exact_brep_ready_links": exact_brep_ready_links,
            "source_decision_selected_controlled_loft_links": source_decision.get(
                "summary", {}
            ).get("selected_controlled_loft_links"),
            "source_decision_rejected_step_brep_candidate_links": source_decision.get(
                "summary", {}
            ).get("rejected_step_brep_candidate_links"),
            "brep_surface_fit_accepted_link_fits": accepted_brep_surface_fit_links,
            "brep_surface_fit_rejected_link_fits": brep_surface_fit.get(
                "summary", {}
            ).get("rejected_link_fits"),
            "brep_surface_fit_shape_mismatch_links": brep_surface_fit.get(
                "summary", {}
            ).get("shape_mismatch_after_bbox_alignment_links"),
            "link_source_exact_brep_body_assignments": link_source_assignment.get(
                "summary", {}
            ).get("exact_brep_body_assignments"),
            "link_source_controlled_loft_assignments": link_source_assignment.get(
                "summary", {}
            ).get("controlled_loft_assignments"),
            "source_shape_fit_ready": exact_source_shape_ready,
            "generated_cad_accepted": bool(generated.get("accepted")),
            "generated_internal_cavity_violation_links": generated_summary.get(
                "internal_cavity_violation_links"
            ),
            "missing_generated_step_links": missing_generated_step_links,
            "parametric_part_scripts": len(parametric_part_scripts) - len(missing_parametric_part_scripts),
            "missing_parametric_part_scripts": missing_parametric_part_scripts,
            "waist_yaw_no_cutout_accepted": bool(waist_yaw_no_cutout.get("accepted")),
            "waist_yaw_no_cutout_method": waist_yaw_no_cutout.get("method"),
            "waist_yaw_generated_sections_ok": waist_yaw_no_cutout.get("generated_sections_ok"),
            "mjcf_load_error": mjcf_load_error,
            "mjcf_mesh_assets": len(mesh_assets),
            "mjcf_mesh_visual_geoms": len(mesh_visual_geoms),
            "mjcf_stl_mesh_assets": sum(
                1 for record in asset_records if record.get("uses_stl")
            ),
            "mjcf_stl_mesh_visual_geoms": len(stl_visual_geoms),
            "links_still_using_stl_mesh_assets": len(stl_asset_links),
            "stl_mesh_asset_links": sorted(stl_asset_links),
            "stl_mesh_assets_have_parametric_provenance": stl_mesh_assets_have_parametric_provenance,
            "unproven_stl_mesh_asset_links": unproven_stl_asset_links,
            "generated_stl_physics_allowed": True,
            "generated_stl_physics_ready": generated_stl_physics_ready,
            "generated_stl_physics_ready_links": len(generated_stl_physics_ready_links),
            "generated_stl_mesh_artifact_free_links": mesh_traceability.get("summary", {}).get(
                "mesh_artifact_free_links"
            ),
            "generated_step_mesh_topology_ready": generated_step_mesh_topology_ready,
            "generated_step_mesh_accepted_topologies": topology.get("summary", {}).get(
                "accepted_topologies"
            ),
            "generated_step_mesh_waist_single_shell_no_cutout_topology_links": topology.get(
                "summary", {}
            ).get("waist_single_shell_no_cutout_topology_links"),
            "generated_step_mesh_topology_failure_links": topology.get("summary", {}).get(
                "topology_failure_links"
            ),
            "generated_step_mesh_repair_preview_accepted_topologies": topology.get(
                "summary", {}
            ).get("repair_preview_accepted_topologies"),
            "generated_step_mesh_repair_preview_envelope_preserved_links": topology.get(
                "summary", {}
            ).get("repair_preview_envelope_preserved_links"),
            "generated_step_mesh_repair_preview_promotable_by_topology_and_envelope": topology.get(
                "summary", {}
            ).get("repair_preview_promotable_by_topology_and_envelope"),
            "generated_step_mesh_topology_resolved_links": topology.get("summary", {}).get(
                "topology_resolved_links"
            ),
            "generated_step_mesh_topology_resolved_by_repair_preview_links": topology.get(
                "summary", {}
            ).get("topology_resolved_by_repair_preview_links"),
            "generated_step_mesh_topology_unresolved_links": topology.get("summary", {}).get(
                "topology_unresolved_links"
            ),
            "generated_step_mesh_topology_unresolved_link_names": topology.get("summary", {}).get(
                "topology_unresolved_link_names"
            ),
            "promoted_step_mesh_topology_ready": promoted_step_mesh_topology_ready,
            "promoted_step_mesh_links": topology_promotion.get("summary", {}).get("links"),
            "promoted_step_mesh_original_step_links": topology_promotion.get(
                "summary", {}
            ).get("promoted_original_step_links"),
            "promoted_step_mesh_repair_preview_links": topology_promotion.get(
                "summary", {}
            ).get("promoted_repair_preview_links"),
            "promoted_step_mesh_accepted_meshes": topology_promotion.get("summary", {}).get(
                "accepted_promoted_meshes"
            ),
            "promoted_step_mesh_max_boundary_edges": topology_promotion.get("summary", {}).get(
                "max_boundary_edges"
            ),
            "promoted_step_mesh_max_nonmanifold_edges": topology_promotion.get(
                "summary", {}
            ).get("max_nonmanifold_edges"),
            "promoted_step_mesh_max_degenerate_faces": topology_promotion.get(
                "summary", {}
            ).get("max_degenerate_faces"),
            "source_stl_usage_policy": (
                "source STLs may be reverse-engineering inputs only; MuJoCo STL "
                "meshes must be generated from parametric CAD/controlled lofts"
            ),
            "missing_mjcf_asset_links": missing_mjcf_asset_links,
            "no_stl_mesh_assets": primary_no_stl_mesh_assets,
            "primary_no_stl_mesh_assets": primary_no_stl_mesh_assets,
            "primary_mjcf_ok": bool(fembot_mjcf.get("ok")),
            "primary_mjcf_nmesh": fembot_mjcf.get("summary", {}).get("nmesh"),
            "primary_mjcf_no_stl_mesh_assets": fembot_mjcf.get("summary", {}).get(
                "no_stl_mesh_assets"
            ),
            "primary_visual_mesh_replacement_ok": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_replacement_ok"
            ),
            "primary_visual_mesh_geoms_replaced": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_geoms_replaced"
            ),
            "primary_visual_mesh_assets_removed": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_assets_removed"
            ),
            "primary_visual_envelope_failures": fembot_mjcf.get("summary", {}).get(
                "primary_visual_envelope_failure_count"
            ),
            "primary_visual_max_bbox_center_delta_m": fembot_mjcf.get("summary", {}).get(
                "primary_visual_max_bbox_center_delta_m"
            ),
            "primary_visual_max_bbox_extent_delta_m": fembot_mjcf.get("summary", {}).get(
                "primary_visual_max_bbox_extent_delta_m"
            ),
            "primary_replacement_links": len(primary_replacement_links),
            "primary_replacement_ok": primary_replacement_ok,
            "no_stl_primitive_surrogate_ok": bool(primitive_mjcf.get("ok")),
            "no_stl_primitive_surrogate_nmesh": primitive_mjcf.get("summary", {}).get(
                "nmesh"
            ),
            "no_stl_primitive_surrogate_visual_replacements": primitive_mjcf.get(
                "summary", {}
            ).get("mesh_visual_geoms_replaced"),
            "no_stl_primitive_surrogate_ellipsoid_visuals": primitive_mjcf.get(
                "summary", {}
            ).get("ellipsoid_visual_primitives"),
            "no_stl_primitive_surrogate_box_visuals": primitive_mjcf.get(
                "summary", {}
            ).get("box_visual_primitives"),
            "no_stl_primitive_surrogate_visual_envelope_matches_generated_cad": primitive_mjcf.get(
                "summary", {}
            ).get("visual_envelope_matches_generated_cad"),
            "no_stl_primitive_surrogate_visual_envelope_failures": primitive_mjcf.get(
                "summary", {}
            ).get("visual_envelope_failure_count"),
            "no_stl_primitive_surrogate_max_visual_bbox_center_delta_m": primitive_mjcf.get(
                "summary", {}
            ).get("max_visual_bbox_center_delta_m"),
            "no_stl_primitive_surrogate_max_visual_bbox_extent_delta_m": primitive_mjcf.get(
                "summary", {}
            ).get("max_visual_bbox_extent_delta_m"),
            "all_cad_parametric_ready": accepted,
            "accepted": accepted,
            "acceptance_blocker": (
                "; ".join(blocker_reasons)
            )
            if not accepted
            else None,
        },
        "source_shape_readiness": {
            "source_decision": {
                "ok": bool(source_decision.get("ok")),
                "accepted": bool(source_decision.get("accepted")),
                "summary": source_decision.get("summary", {}),
            },
            "brep_surface_fit": {
                "ok": bool(brep_surface_fit.get("ok")),
                "accepted": bool(brep_surface_fit.get("accepted")),
                "summary": brep_surface_fit.get("summary", {}),
            },
            "link_source_assignment": {
                "ok": bool(link_source_assignment.get("ok")),
                "accepted": bool(link_source_assignment.get("accepted")),
                "summary": link_source_assignment.get("summary", {}),
            },
            "generated_placeholder_reference_links": generated_placeholder_links,
            "generated_source_fitted_controlled_loft_links": (
                generated_source_fitted_loft_links
            ),
            "source_shape_fit_ready": exact_source_shape_ready,
        },
        "generated_topology": {
            "ok": bool(topology.get("ok")),
            "accepted": bool(topology.get("accepted")),
            "summary": topology.get("summary", {}),
        },
        "topology_promotion": {
            "ok": bool(topology_promotion.get("ok")),
            "accepted": bool(topology_promotion.get("accepted")),
            "summary": topology_promotion.get("summary", {}),
            "source": topology_promotion.get("source", {}),
        },
        "mesh_traceability": {
            "ok": bool(mesh_traceability.get("ok")),
            "accepted": bool(mesh_traceability.get("accepted")),
            "summary": mesh_traceability.get("summary", {}),
        },
        "cad_primitive_mjcf": {
            "ok": bool(primitive_mjcf.get("ok")),
            "accepted": bool(primitive_mjcf.get("accepted")),
            "summary": primitive_mjcf.get("summary", {}),
            "output": primitive_mjcf.get("output", {}),
        },
        "waist_yaw_no_cutout": {
            "accepted": bool(waist_yaw_no_cutout.get("accepted")),
            "summary": {
                "method": waist_yaw_no_cutout.get("method"),
                "generated_sections_ok": waist_yaw_no_cutout.get("generated_sections_ok"),
                "source_fragmented_sections": waist_yaw_no_cutout.get("source_fragmented_sections"),
                "topology": waist_yaw_no_cutout.get("topology", {}),
                "error": waist_yaw_no_cutout.get("error"),
            },
        },
        "parametric_part_scripts": list(parametric_part_scripts.values()),
        "mesh_assets": asset_records,
        "mesh_visual_geoms": mesh_visual_geoms,
    }


def dump_fembot_all_cad_readiness_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_all_cad_readiness_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-all-cad-readiness.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_all_cad_readiness_proof_json(report), encoding="utf-8")
    return output
