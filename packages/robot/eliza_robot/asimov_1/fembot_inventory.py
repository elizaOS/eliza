"""Fembot production inventory and proof contract for ASIMOV-1."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.collision_sweep import build_asimov1_collision_sweep_proof
from eliza_robot.asimov_1.constants import (
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_MAIN_STEP,
    ASIMOV1_MECHANICAL_ROOT,
    ASIMOV1_SOURCE_MESH_DIR,
)
from eliza_robot.asimov_1.fembot_assembly import build_fembot_assembly_proof
from eliza_robot.asimov_1.fembot_all_cad_readiness import (
    build_fembot_all_cad_readiness_proof,
)
from eliza_robot.asimov_1.fembot_body_matching import build_fembot_body_matching_proof
from eliza_robot.asimov_1.fembot_cad_toolchain import build_fembot_cad_toolchain_readiness_proof
from eliza_robot.asimov_1.fembot_clearance_projection import build_fembot_clearance_projection_proof
from eliza_robot.asimov_1.fembot_component_constraints import (
    build_fembot_component_constraint_coverage_proof,
)
from eliza_robot.asimov_1.fembot_controller_validation import (
    build_fembot_controller_validation_proof,
)
from eliza_robot.asimov_1.fembot_foot_handling import build_fembot_foot_handling_proof
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_hardware_measurements import (
    build_fembot_hardware_measurement_requirements_proof,
)
from eliza_robot.asimov_1.fembot_inertia_calibration import (
    build_fembot_inertia_calibration_proof,
)
from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof
from eliza_robot.asimov_1.fembot_link_sources import build_fembot_link_source_assignment_proof
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof
from eliza_robot.asimov_1.fembot_media_review import build_fembot_media_review_proof
from eliza_robot.asimov_1.fembot_mesh_traceability import (
    build_fembot_mesh_parametric_traceability_proof,
)
from eliza_robot.asimov_1.fembot_mold_dfm import build_fembot_mold_dfm_proof
from eliza_robot.asimov_1.fembot_motion_validation import build_fembot_collision_dynamics_proof
from eliza_robot.asimov_1.fembot_parametric_constraints import (
    build_fembot_parametric_constraints_proof,
)
from eliza_robot.asimov_1.fembot_proofs import (
    FEMBOT_PROOF_CONTRACTS,
    fembot_proof_contract_report,
)
from eliza_robot.asimov_1.fembot_slimming_envelope import build_fembot_slimming_envelope_proof
from eliza_robot.asimov_1.fembot_source_manifest import build_fembot_source_manifest_proof
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof
from eliza_robot.asimov_1.fembot_supplier_pocket_plan import (
    build_fembot_supplier_pocket_plan_proof,
)
from eliza_robot.asimov_1.fembot_surface_quality import build_fembot_surface_quality_proof
from eliza_robot.asimov_1.fembot_thinness_frontier import (
    build_fembot_thinness_frontier_proof,
)
from eliza_robot.asimov_1.fembot_topology import build_fembot_topology_proof
from eliza_robot.asimov_1.fembot_visual_review import build_fembot_visual_review_proof
from eliza_robot.asimov_1.mujoco_load_proof import build_mujoco_load_proof
from eliza_robot.asimov_1.parametric_inventory import collect_asimov1_parametric_inventory

FEMBOT_BODY_GROUP_LINKS: dict[str, tuple[str, ...]] = {
    "torso": ("IMU_ORIGIN", "WAIST_YAW"),
    "head": ("NECK_YAW", "NECK_PITCH"),
    "arm": (
        "LEFT_SHOULDER_PITCH",
        "RIGHT_SHOULDER_PITCH",
        "LEFT_SHOULDER_ROLL",
        "RIGHT_SHOULDER_ROLL",
        "LEFT_SHOULDER_YAW",
        "RIGHT_SHOULDER_YAW",
        "LEFT_ELBOW",
        "RIGHT_ELBOW",
        "LEFT_WRIST_YAW",
        "RIGHT_WRIST_YAW",
    ),
    "leg": (
        "LEFT_HIP_PITCH",
        "RIGHT_HIP_PITCH",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_KNEE",
        "LEFT_ANKLE_A",
        "RIGHT_ANKLE_A",
        "LEFT_ANKLE_B",
        "RIGHT_ANKLE_B",
    ),
    "foot": ("LEFT_TOE", "RIGHT_TOE"),
}


# These assembly families are candidates from the ASIMOV source tree and the
# current FreeCAD/STL assignment scripts. They are not final proof that every
# fabrication STEP body maps to a given simulation link.
FEMBOT_BODY_GROUP_ASSEMBLY_CANDIDATES: dict[str, tuple[str, ...]] = {
    "torso": ("200", "700"),
    "head": ("100",),
    "arm": ("300", "400"),
    "leg": ("500", "600"),
    "foot": ("500", "600"),
}


FEMBOT_PROOF_TYPES: tuple[str, ...] = (
    *(contract.proof_type for contract in FEMBOT_PROOF_CONTRACTS),
)


MATERIAL_PROCESS_BY_FOLDER: dict[str, dict[str, str]] = {
    "ALU_7075": {
        "material": "7075 aluminum",
        "process": "CNC machining or sheet/plate fabrication",
        "critical_tests": "flatness, bore circularity, thread/fastener access, minimum web thickness",
    },
    "SML_316L": {
        "material": "316L stainless steel",
        "process": "sheet metal/laser cut or machined stainless",
        "critical_tests": "flatness, bend allowance, edge distance, corrosion-compatible finish",
    },
    "MJF_PA12": {
        "material": "PA12 nylon",
        "process": "MJF additive manufacturing or reconstructed molded shell",
        "critical_tests": "minimum wall thickness, smoothness, watertightness, draft/undercut review",
    },
    "OFF_THE_SHELF": {
        "material": "vendor-defined off-the-shelf component",
        "process": "purchased component",
        "critical_tests": "do not scale; preserve vendor envelope, axes, and mounting pattern",
    },
}


@dataclass(frozen=True)
class FembotStepCandidate:
    path: str
    assembly: str
    fabrication_class: str
    material: str
    process: str
    critical_tests: str
    sha256: str | None


@dataclass(frozen=True)
class FembotBodyGroupRecord:
    group: str
    links: list[str]
    assembly_candidates: list[str]
    step_candidates: list[FembotStepCandidate]
    source_stl_count: int
    parametric_links: int
    spline_fit_links: int
    interface_links: int
    topology_links: int
    surface_distance_links: int
    proven_step_links: int
    required_proofs: list[str]
    missing_proofs: list[str]
    optimization_intent: str


def _step_candidates_for_assemblies(
    assemblies: tuple[str, ...],
    *,
    mechanical_root: Path,
) -> list[FembotStepCandidate]:
    candidates: list[FembotStepCandidate] = []
    for assembly in assemblies:
        root = mechanical_root / assembly
        for path in sorted(root.rglob("*.STEP")) + sorted(root.rglob("*.step")):
            if path.name.upper() == f"ASV1_{assembly}.STEP":
                fabrication_class = "ASSEMBLY"
                meta = {
                    "material": "mixed assembly",
                    "process": "source assembly reference",
                    "critical_tests": "split into fabrication bodies before production edits",
                }
            else:
                fabrication_class = _fabrication_class(path)
                meta = MATERIAL_PROCESS_BY_FOLDER.get(
                    fabrication_class,
                    {
                        "material": "unknown",
                        "process": "unknown",
                        "critical_tests": "manual material/process classification required",
                    },
                )
            candidates.append(
                FembotStepCandidate(
                    path=str(path),
                    assembly=assembly,
                    fabrication_class=fabrication_class,
                    material=meta["material"],
                    process=meta["process"],
                    critical_tests=meta["critical_tests"],
                    sha256=sha256_file(path) if path.is_file() else None,
                )
            )
    return candidates


def _fabrication_class(path: Path) -> str:
    parts = {part.upper(): part for part in path.parts}
    for klass in MATERIAL_PROCESS_BY_FOLDER:
        if klass in parts:
            return klass
    return "unknown"


def _source_stl_links(mesh_dir: Path) -> set[str]:
    if not mesh_dir.is_dir():
        return set()
    return {path.stem.upper() for path in mesh_dir.glob("*.STL")}


def _records_by_link(parametric_inventory: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records = parametric_inventory.get("records", [])
    return {
        str(record.get("link", "")).upper(): record
        for record in records
        if isinstance(record, dict)
    }


def _group_intent(group: str) -> str:
    if group == "torso":
        return (
            "Minimize torso depth and waist/hip envelope while preserving height, "
            "waist, neck, shoulder, and hip interfaces; curved torso shell must be "
            "smooth and moldable."
        )
    if group == "head":
        return "Slim head/neck envelope while preserving neck mate, sensor keepouts, and smooth cranium surfaces."
    if group == "arm":
        return "Minimize arm diameters and shoulder/elbow/wrist envelopes while preserving bores and joint travel."
    if group == "leg":
        return "Minimize thigh, knee, calf, and ankle envelopes while preserving leg length, motors, rings, and load paths."
    if group == "foot":
        return "Minimize foot/ankle bulk without reducing required sole contact, toe mate, or balance envelope."
    return "Unclassified fembot optimization group."


def _missing_group_proofs(
    *,
    group_links: tuple[str, ...],
    link_records: dict[str, dict[str, Any]],
    dynamic_mujoco_ok: bool,
    static_mujoco_ok: bool,
    collision_sweep_accepted: bool,
    surface_quality_accepted: bool,
    keepout_accepted: bool,
    generated_topology_links: set[str] | None = None,
) -> list[str]:
    missing: set[str] = set()
    generated_topology_links = generated_topology_links or set()
    for link in group_links:
        record = link_records.get(link)
        if not record:
            missing.update(
                {
                    "source_step_or_controlled_loft",
                    "interface_preservation",
                    "topology",
                    "surface_distance",
                }
            )
            continue
        if not record.get("proven_against_step"):
            missing.add("source_step_or_controlled_loft")
        if not record.get("interface_proven"):
            missing.add("interface_preservation")
        if not record.get("topology_proven") and link not in generated_topology_links:
            missing.add("topology")
        if not record.get("surface_distance_proven"):
            missing.add("surface_distance")

    missing.update(
        {
            "material_properties",
            "manufacturing_process",
            "hardware_measurements",
            "whole_robot_assembly",
            "structural_sanity",
            "visual_review",
            "visual_motion_media",
        }
    )
    if not collision_sweep_accepted:
        missing.add("collision_sweep")
    if not surface_quality_accepted:
        missing.add("flatness_or_smoothness")
    if not keepout_accepted:
        missing.add("motor_bearing_ring_gear_pulley_fastener_keepouts")
    if not static_mujoco_ok:
        missing.add("mujoco_static")
    if not dynamic_mujoco_ok:
        missing.add("mujoco_dynamic")
    return [proof for proof in FEMBOT_PROOF_TYPES if proof in missing]


def collect_fembot_inventory(
    *,
    mechanical_root: Path = ASIMOV1_MECHANICAL_ROOT,
    main_step: Path = ASIMOV1_MAIN_STEP,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
) -> dict[str, Any]:
    """Return the current production-readiness inventory for ASIMOV fembot.

    This is intentionally stricter than the existing visual feminization report:
    a group is not production ready until STEP/B-rep or controlled-loft source,
    manufacturing analysis, collision, dynamic MuJoCo, structural, and visual
    evidence exist for all links in that group.
    """
    parametric = collect_asimov1_parametric_inventory(
        mesh_dir=mesh_dir,
        main_step=main_step,
        mjcf=mjcf_path,
    )
    mujoco = build_mujoco_load_proof(mjcf_path=mjcf_path)
    collision_sweep = build_asimov1_collision_sweep_proof(mjcf_path=mjcf_path)
    source_stls = _source_stl_links(mesh_dir)
    by_link = _records_by_link(parametric)
    static_mujoco_ok = bool(mujoco.get("static", {}).get("ok"))
    dynamic_mujoco_ok = bool(mujoco.get("ok"))
    collision_sweep_accepted = bool(collision_sweep.get("accepted"))
    surface_quality_accepted = False
    keepout_accepted = False

    group_records: list[FembotBodyGroupRecord] = []
    for group, links in FEMBOT_BODY_GROUP_LINKS.items():
        assemblies = FEMBOT_BODY_GROUP_ASSEMBLY_CANDIDATES[group]
        step_candidates = _step_candidates_for_assemblies(
            assemblies,
            mechanical_root=mechanical_root,
        )
        link_records = [by_link.get(link, {}) for link in links]
        group_records.append(
            FembotBodyGroupRecord(
                group=group,
                links=list(links),
                assembly_candidates=list(assemblies),
                step_candidates=step_candidates,
                source_stl_count=sum(1 for link in links if link in source_stls),
                parametric_links=sum(1 for record in link_records if record.get("part_script")),
                spline_fit_links=sum(1 for record in link_records if record.get("spline_fit_proven")),
                interface_links=sum(1 for record in link_records if record.get("interface_proven")),
                topology_links=sum(1 for record in link_records if record.get("topology_proven")),
                surface_distance_links=sum(
                    1 for record in link_records if record.get("surface_distance_proven")
                ),
                proven_step_links=sum(1 for record in link_records if record.get("proven_against_step")),
                required_proofs=list(FEMBOT_PROOF_TYPES),
                missing_proofs=_missing_group_proofs(
                    group_links=links,
                    link_records=by_link,
                    dynamic_mujoco_ok=dynamic_mujoco_ok,
                    static_mujoco_ok=static_mujoco_ok,
                    collision_sweep_accepted=collision_sweep_accepted,
                    surface_quality_accepted=surface_quality_accepted,
                    keepout_accepted=keepout_accepted,
                ),
                optimization_intent=_group_intent(group),
            )
        )

    all_links = sorted({link for links in FEMBOT_BODY_GROUP_LINKS.values() for link in links})
    records_dict = [_group_record_dict(record) for record in group_records]
    source_manifest = build_fembot_source_manifest_proof(
        records_dict,
        main_step=main_step,
        mechanical_root=mechanical_root,
        mesh_dir=mesh_dir,
    )
    body_matching = build_fembot_body_matching_proof(
        records_dict,
        mesh_dir=mesh_dir,
        max_files_per_group=1,
    )
    link_source_assignments = build_fembot_link_source_assignment_proof(
        records_dict,
        main_step=main_step,
        mechanical_root=mechanical_root,
        mesh_dir=mesh_dir,
        body_matching_report=body_matching,
    )
    mesh_traceability = build_fembot_mesh_parametric_traceability_proof(
        inventory=parametric,
        source_assignment_report=link_source_assignments,
    )
    accepted_source_links = {
        str(record.get("link"))
        for record in link_source_assignments.get("link_assignments", [])
        if record.get("accepted")
    }
    for record in records_dict:
        links = [str(link) for link in record.get("links", [])]
        if links and all(link in accepted_source_links for link in links):
            record["missing_proofs"] = [
                proof
                for proof in record["missing_proofs"]
                if proof != "source_step_or_controlled_loft"
            ]
    cad_toolchain = build_fembot_cad_toolchain_readiness_proof()
    keepouts = build_fembot_keepout_proof(records_dict, mjcf_path=mjcf_path, mesh_dir=mesh_dir)
    component_constraints = build_fembot_component_constraint_coverage_proof(
        records_dict,
        keepout_report=keepouts,
    )
    slimming_envelope = build_fembot_slimming_envelope_proof(
        records_dict,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    clearance_projection = build_fembot_clearance_projection_proof(
        records_dict,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    generated_cad = build_fembot_generated_cad_envelope_proof(
        records_dict,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
        clearance_report=clearance_projection,
        component_constraint_report=component_constraints,
    )
    hardware_measurements = build_fembot_hardware_measurement_requirements_proof(
        records_dict,
        component_constraint_report=component_constraints,
        generated_cad_report=generated_cad,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
    )
    if hardware_measurements.get("accepted"):
        for record in records_dict:
            record["missing_proofs"] = [
                proof
                for proof in record["missing_proofs"]
                if proof != "hardware_measurements"
            ]
    generated_topology = build_fembot_topology_proof(generated_cad_report=generated_cad)
    generated_topology_links = {
        str(record.get("link")).upper()
        for record in generated_topology.get("link_topology", [])
        if record.get("accepted")
    }
    for record in records_dict:
        links = [str(link) for link in record.get("links", [])]
        if links and all(link in generated_topology_links for link in links):
            record["missing_proofs"] = [
                proof for proof in record["missing_proofs"] if proof != "topology"
            ]
    material_manufacturing = build_fembot_material_manufacturing_proof(
        records_dict,
        generated_cad_report=generated_cad,
    )
    mold_dfm = build_fembot_mold_dfm_proof(
        records_dict,
        generated_cad_report=generated_cad,
    )
    surface_quality = build_fembot_surface_quality_proof(
        records_dict,
        mesh_dir=mesh_dir,
        generated_cad_report=generated_cad,
    )
    foot_handling = build_fembot_foot_handling_proof(
        records_dict,
        source_mjcf=mjcf_path,
        generated_cad_report=generated_cad,
        material_report=material_manufacturing,
        surface_report=surface_quality,
    )
    inertia_calibration = build_fembot_inertia_calibration_proof(
        records_dict,
        source_mjcf=mjcf_path,
        generated_cad_report=generated_cad,
        material_report=material_manufacturing,
        hardware_measurements=hardware_measurements,
    )
    controller_validation = build_fembot_controller_validation_proof(
        records_dict,
        source_mjcf=mjcf_path,
    )
    structural_sanity = build_fembot_structural_sanity_proof(
        records_dict,
        generated_cad_report=generated_cad,
        generated_topology_report=generated_topology,
    )
    thinness_frontier = build_fembot_thinness_frontier_proof(
        records_dict,
        slimming_report=slimming_envelope,
        clearance_report=clearance_projection,
        generated_cad_report=generated_cad,
        structural_report=structural_sanity,
        component_constraint_report=component_constraints,
    )
    parametric_constraints = build_fembot_parametric_constraints_proof(
        records_dict,
        slimming_report=slimming_envelope,
        clearance_report=clearance_projection,
        generated_cad_report=generated_cad,
        material_report=material_manufacturing,
        surface_report=surface_quality,
        topology_report=generated_topology,
        mold_dfm_report=mold_dfm,
        thinness_frontier_report=thinness_frontier,
    )
    supplier_pocket_plan = build_fembot_supplier_pocket_plan_proof(
        records_dict,
        component_constraint_report=component_constraints,
        generated_cad_report=generated_cad,
        parametric_constraint_report=parametric_constraints,
    )
    all_cad_readiness = build_fembot_all_cad_readiness_proof(
        records_dict,
        generated_cad_report=generated_cad,
    )
    assembly = build_fembot_assembly_proof(
        records_dict,
        mesh_dir=mesh_dir,
        mjcf_path=mjcf_path,
        generated_cad_report=generated_cad,
        mujoco_report=mujoco,
        structural_report=structural_sanity,
    )
    fembot_collision_dynamics = build_fembot_collision_dynamics_proof(
        records_dict,
        mjcf_path=mjcf_path,
        generated_cad_report=generated_cad,
        structural_report=structural_sanity,
        foot_handling_report=foot_handling,
        inertia_calibration_report=inertia_calibration,
        controller_validation_report=controller_validation,
    )
    visual_review = build_fembot_visual_review_proof(
        records_dict,
        generated_cad_report=generated_cad,
    )
    visual_motion_media = build_fembot_media_review_proof()
    if visual_motion_media.get("ok"):
        for record in records_dict:
            record["missing_proofs"] = [
                proof for proof in record["missing_proofs"] if proof != "visual_motion_media"
            ]
    ready_groups = [record["group"] for record in records_dict if not record["missing_proofs"]]
    return {
        "schema": "asimov-fembot-inventory-v1",
        "ok": bool(main_step.is_file() and len(source_stls) == 28 and len(all_links) == 28),
        "production_ready": len(ready_groups) == len(records_dict) and bool(records_dict),
        "source": {
            "main_step": str(main_step),
            "main_step_sha256": sha256_file(main_step) if main_step.is_file() else None,
            "mechanical_root": str(mechanical_root),
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
        },
        "counts": {
            "body_groups": len(records_dict),
            "links": len(all_links),
            "source_stl_links": len(source_stls),
            "ready_groups": len(ready_groups),
            "step_candidate_files": sum(len(record["step_candidates"]) for record in records_dict),
            "proven_step_links": sum(record["proven_step_links"] for record in records_dict),
            "spline_fit_links": sum(record["spline_fit_links"] for record in records_dict),
            "interface_links": sum(record["interface_links"] for record in records_dict),
            "topology_links": sum(record["topology_links"] for record in records_dict),
            "surface_distance_links": sum(record["surface_distance_links"] for record in records_dict),
        },
        "mujoco": {
            "static_ok": static_mujoco_ok,
            "dynamic_ok": dynamic_mujoco_ok,
            "summary": mujoco.get("summary", {}),
            "load_error": mujoco.get("load", {}).get("error"),
        },
        "source_manifest": {
            "ok": bool(source_manifest.get("ok")),
            "accepted": bool(source_manifest.get("accepted")),
            "summary": source_manifest.get("summary", {}),
        },
        "link_source_assignments": {
            "ok": bool(link_source_assignments.get("ok")),
            "accepted": bool(link_source_assignments.get("accepted")),
            "summary": link_source_assignments.get("summary", {}),
        },
        "mesh_traceability": {
            "ok": bool(mesh_traceability.get("ok")),
            "accepted": bool(mesh_traceability.get("accepted")),
            "summary": mesh_traceability.get("summary", {}),
        },
        "body_matching": {
            "ok": bool(body_matching.get("ok")),
            "accepted": bool(body_matching.get("accepted")),
            "summary": body_matching.get("summary", {}),
        },
        "cad_toolchain": {
            "ok": bool(cad_toolchain.get("ok")),
            "accepted": bool(cad_toolchain.get("accepted")),
            "summary": cad_toolchain.get("summary", {}),
            "selected_backend": cad_toolchain.get("selected_backend"),
        },
        "collision_sweep": {
            "ok": bool(collision_sweep.get("ok")),
            "accepted": collision_sweep_accepted,
            "summary": collision_sweep.get("summary", {}),
        },
        "fembot_collision_dynamics": {
            "ok": bool(fembot_collision_dynamics.get("ok")),
            "accepted": bool(fembot_collision_dynamics.get("accepted")),
            "summary": fembot_collision_dynamics.get("summary", {}),
            "contact_pairs": fembot_collision_dynamics.get("contact_pairs", []),
        },
        "material_manufacturing": {
            "ok": bool(material_manufacturing.get("ok")),
            "accepted": bool(material_manufacturing.get("accepted")),
            "summary": material_manufacturing.get("summary", {}),
        },
        "mold_dfm": {
            "ok": bool(mold_dfm.get("ok")),
            "accepted": bool(mold_dfm.get("accepted")),
            "summary": mold_dfm.get("summary", {}),
        },
        "surface_quality": {
            "ok": bool(surface_quality.get("ok")),
            "accepted": bool(surface_quality.get("accepted")),
            "summary": surface_quality.get("summary", {}),
        },
        "foot_handling": {
            "ok": bool(foot_handling.get("ok")),
            "accepted": bool(foot_handling.get("accepted")),
            "summary": foot_handling.get("summary", {}),
        },
        "inertia_calibration": {
            "ok": bool(inertia_calibration.get("ok")),
            "accepted": bool(inertia_calibration.get("accepted")),
            "summary": inertia_calibration.get("summary", {}),
        },
        "controller_validation": {
            "ok": bool(controller_validation.get("ok")),
            "accepted": bool(controller_validation.get("accepted")),
            "summary": controller_validation.get("summary", {}),
        },
        "keepouts": {
            "ok": bool(keepouts.get("ok")),
            "accepted": bool(keepouts.get("accepted")),
            "summary": keepouts.get("summary", {}),
        },
        "component_constraints": {
            "ok": bool(component_constraints.get("ok")),
            "accepted": bool(component_constraints.get("accepted")),
            "summary": component_constraints.get("summary", {}),
        },
        "slimming_envelope": {
            "ok": bool(slimming_envelope.get("ok")),
            "accepted": bool(slimming_envelope.get("accepted")),
            "summary": slimming_envelope.get("summary", {}),
        },
        "clearance_projection": {
            "ok": bool(clearance_projection.get("ok")),
            "accepted": bool(clearance_projection.get("accepted")),
            "summary": clearance_projection.get("summary", {}),
        },
        "generated_cad": {
            "ok": bool(generated_cad.get("ok")),
            "accepted": bool(generated_cad.get("accepted")),
            "summary": generated_cad.get("summary", {}),
        },
        "hardware_measurements": {
            "ok": bool(hardware_measurements.get("ok")),
            "accepted": bool(hardware_measurements.get("accepted")),
            "summary": hardware_measurements.get("summary", {}),
        },
        "generated_topology": {
            "ok": bool(generated_topology.get("ok")),
            "accepted": bool(generated_topology.get("accepted")),
            "summary": generated_topology.get("summary", {}),
        },
        "structural_sanity": {
            "ok": bool(structural_sanity.get("ok")),
            "accepted": bool(structural_sanity.get("accepted")),
            "summary": structural_sanity.get("summary", {}),
        },
        "thinness_frontier": {
            "ok": bool(thinness_frontier.get("ok")),
            "accepted": bool(thinness_frontier.get("accepted")),
            "summary": thinness_frontier.get("summary", {}),
        },
        "parametric_constraints": {
            "ok": bool(parametric_constraints.get("ok")),
            "accepted": bool(parametric_constraints.get("accepted")),
            "summary": parametric_constraints.get("summary", {}),
        },
        "supplier_pocket_plan": {
            "ok": bool(supplier_pocket_plan.get("ok")),
            "accepted": bool(supplier_pocket_plan.get("accepted")),
            "summary": supplier_pocket_plan.get("summary", {}),
        },
        "all_cad_readiness": {
            "ok": bool(all_cad_readiness.get("ok")),
            "accepted": bool(all_cad_readiness.get("accepted")),
            "summary": all_cad_readiness.get("summary", {}),
        },
        "assembly": {
            "ok": bool(assembly.get("ok")),
            "accepted": bool(assembly.get("accepted")),
            "summary": assembly.get("summary", {}),
        },
        "visual_review": {
            "ok": bool(visual_review.get("ok")),
            "accepted": bool(visual_review.get("accepted")),
            "summary": visual_review.get("summary", {}),
        },
        "visual_motion_media": {
            "ok": bool(visual_motion_media.get("ok")),
            "accepted": bool(visual_motion_media.get("accepted")),
            "summary": visual_motion_media.get("summary", {}),
        },
        "proof_contracts": fembot_proof_contract_report(),
        "body_groups": records_dict,
    }


def _group_record_dict(record: FembotBodyGroupRecord) -> dict[str, Any]:
    data = asdict(record)
    data["step_candidates"] = [asdict(candidate) for candidate in record.step_candidates]
    data["step_candidate_count"] = len(record.step_candidates)
    return data


def dump_fembot_inventory_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
