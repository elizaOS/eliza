"""Trace visual meshes through the controlled parametric fembot source chain."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.parametric_inventory import (
    ASIMOV_PARAM_PROOFS,
    collect_asimov1_parametric_inventory,
)

MESH_TRACEABILITY_SCHEMA = "asimov-fembot-mesh-parametric-traceability-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return raw if isinstance(raw, dict) else None


def _source_assignment_records(proof_root: Path) -> dict[str, dict[str, Any]]:
    raw = _load_json(proof_root / "fembot-link-source-assignments.json")
    if not raw or raw.get("schema") != "asimov-fembot-link-source-assignment-v1":
        return {}
    return {
        str(record.get("link", "")).upper(): record
        for record in raw.get("link_assignments", [])
        if isinstance(record, dict) and record.get("link")
    }


def _missing_traceability(record: dict[str, Any], assignment: dict[str, Any] | None) -> list[str]:
    missing: list[str] = []
    if not record.get("source_stl_sha256"):
        missing.append("source_stl_hash")
    if not record.get("mjcf_mesh_refs"):
        missing.append("mujoco_mesh_reference")
    if not record.get("connection_spec"):
        missing.append("connection_spec")
    if not record.get("part_script"):
        missing.append("part_script")
    if not record.get("output_stl_sha256"):
        missing.append("parametric_output_hash")
    if not record.get("spline_fit_proven"):
        missing.append("spline_fit")
    if not record.get("interface_proven"):
        missing.append("attachment_interface")
    if not record.get("topology_proven"):
        missing.append("watertight_topology")
    if not record.get("surface_distance_proven"):
        missing.append("surface_distance")
    if not assignment:
        missing.append("source_assignment")
    elif not assignment.get("accepted"):
        missing.append("accepted_source_assignment")
    return missing


def build_fembot_mesh_parametric_traceability_proof(
    *,
    inventory: dict[str, Any] | None = None,
    source_assignment_report: dict[str, Any] | None = None,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
) -> dict[str, Any]:
    """Return per-mesh evidence that STL physics meshes have parametric sources.

    Source STL meshes are allowed only as reverse-engineering inputs. Generated
    STL meshes are allowed as downstream physics artifacts when every mesh traces
    to a controlled parametric loft, preserves interfaces, and has clean topology
    and surface-distance proof.
    """
    inventory = inventory or collect_asimov1_parametric_inventory(proof_root=proof_root)
    if source_assignment_report is not None:
        assignments = {
            str(record.get("link", "")).upper(): record
            for record in source_assignment_report.get("link_assignments", [])
            if isinstance(record, dict) and record.get("link")
        }
    else:
        assignments = _source_assignment_records(proof_root)

    records: list[dict[str, Any]] = []
    for source_record in inventory.get("records", []):
        if not isinstance(source_record, dict):
            continue
        link = str(source_record.get("link", "")).upper()
        assignment = assignments.get(link)
        missing = _missing_traceability(source_record, assignment)
        exact_brep_ready = bool(
            source_record.get("proven_against_step")
            or (assignment and assignment.get("exact_brep_body_assigned"))
        )
        controlled_loft_ready = bool(
            assignment
            and assignment.get("accepted")
            and assignment.get("controlled_loft_assigned")
        )
        generated_stl_physics_ready = bool(
            not missing
            and controlled_loft_ready
            and source_record.get("output_stl_sha256")
            and source_record.get("topology_proven")
            and source_record.get("surface_distance_proven")
        )
        records.append(
            {
                "link": link,
                "mesh_file": source_record.get("mesh_file"),
                "source_stl": source_record.get("source_stl"),
                "source_stl_sha256": source_record.get("source_stl_sha256"),
                "mjcf_mesh_refs": source_record.get("mjcf_mesh_refs", []),
                "connection_spec": bool(source_record.get("connection_spec")),
                "part_script": source_record.get("part_script"),
                "output_stl": source_record.get("output_stl"),
                "output_stl_sha256": source_record.get("output_stl_sha256"),
                "spline_fit_proof": source_record.get("spline_fit_proof"),
                "spline_fit_proven": bool(source_record.get("spline_fit_proven")),
                "attachment_interface_proven": bool(source_record.get("interface_proven")),
                "topology_proven": bool(source_record.get("topology_proven")),
                "surface_distance_proven": bool(source_record.get("surface_distance_proven")),
                "accepted_source_assignment": bool(assignment and assignment.get("accepted")),
                "controlled_loft_source_ready": controlled_loft_ready,
                "exact_brep_source_ready": exact_brep_ready,
                "traceability_ready": not missing,
                "generated_stl_physics_ready": generated_stl_physics_ready,
                "mesh_artifact_free": generated_stl_physics_ready,
                "production_source_ready": generated_stl_physics_ready,
                "missing": missing,
                "source_assignment": {
                    "source_kind": assignment.get("source_kind") if assignment else None,
                    "controlled_loft_proof": assignment.get("controlled_loft_proof")
                    if assignment
                    else None,
                    "fit_max_error_m": assignment.get("fit_max_error_m") if assignment else None,
                    "fit_rms_error_m": assignment.get("fit_rms_error_m") if assignment else None,
                    "interface_levels_m": assignment.get("interface_levels_m") if assignment else [],
                    "interface_max_delta_m": assignment.get("interface_max_delta_m")
                    if assignment
                    else None,
                    "surface_symmetric_hausdorff_m": assignment.get("surface_symmetric_hausdorff_m")
                    if assignment
                    else None,
                },
            }
        )

    mesh_count = len(records)
    traceable_count = sum(1 for record in records if record["traceability_ready"])
    exact_brep_count = sum(1 for record in records if record["exact_brep_source_ready"])
    controlled_loft_count = sum(
        1 for record in records if record["controlled_loft_source_ready"]
    )
    generated_stl_physics_ready_count = sum(
        1 for record in records if record["generated_stl_physics_ready"]
    )
    mesh_artifact_free_count = sum(
        1 for record in records if record["mesh_artifact_free"]
    )
    missing_by_link = {
        record["link"]: record["missing"] for record in records if record["missing"]
    }
    controlled_loft_ready = mesh_count == 28 and traceable_count == mesh_count
    generated_stl_physics_ready = (
        mesh_count == 28 and generated_stl_physics_ready_count == mesh_count
    )
    production_ready = controlled_loft_ready and generated_stl_physics_ready
    return {
        "schema": MESH_TRACEABILITY_SCHEMA,
        "ok": controlled_loft_ready,
        "accepted": production_ready,
        "source": {
            "inventory_schema": inventory.get("schema"),
            "proof_root": str(proof_root),
            "source_assignment_schema": "asimov-fembot-link-source-assignment-v1"
            if assignments
            else None,
        },
        "summary": {
            "mesh_files": mesh_count,
            "traceability_ready_links": traceable_count,
            "controlled_loft_source_ready_links": controlled_loft_count,
            "exact_brep_source_ready_links": exact_brep_count,
            "generated_stl_physics_ready_links": generated_stl_physics_ready_count,
            "mesh_artifact_free_links": mesh_artifact_free_count,
            "missing_traceability_links": len(missing_by_link),
            "mujoco_mapped_links": sum(1 for record in records if record["mjcf_mesh_refs"]),
            "spline_fit_links": sum(1 for record in records if record["spline_fit_proven"]),
            "attachment_interface_links": sum(
                1 for record in records if record["attachment_interface_proven"]
            ),
            "topology_links": sum(1 for record in records if record["topology_proven"]),
            "surface_distance_links": sum(
                1 for record in records if record["surface_distance_proven"]
            ),
            "generated_stl_physics_ready": generated_stl_physics_ready,
            "accepted": production_ready,
            "acceptance_blocker": (
                None
                if production_ready
                else "at least one generated STL physics mesh lacks parametric provenance or clean artifact-free topology/surface proof"
            ),
        },
        "missing_by_link": missing_by_link,
        "records": records,
    }


def dump_fembot_mesh_parametric_traceability_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mesh_parametric_traceability_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mesh-parametric-traceability.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_mesh_parametric_traceability_proof_json(report),
        encoding="utf-8",
    )
    return output
