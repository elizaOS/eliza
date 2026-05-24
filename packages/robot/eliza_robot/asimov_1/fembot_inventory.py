"""Fembot production inventory and proof contract for ASIMOV-1."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import (
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_MAIN_STEP,
    ASIMOV1_MECHANICAL_ROOT,
    ASIMOV1_SOURCE_MESH_DIR,
)
from eliza_robot.asimov_1.collision_sweep import build_asimov1_collision_sweep_proof
from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof
from eliza_robot.asimov_1.fembot_surface_quality import build_fembot_surface_quality_proof
from eliza_robot.asimov_1.mujoco_load_proof import build_mujoco_load_proof
from eliza_robot.asimov_1.parametric_inventory import collect_asimov1_parametric_inventory
from eliza_robot.asimov_1.fembot_proofs import (
    FEMBOT_PROOF_CONTRACTS,
    fembot_proof_contract_report,
)


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
) -> list[str]:
    missing: set[str] = set()
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
        if not record.get("topology_proven"):
            missing.add("topology")
        if not record.get("surface_distance_proven"):
            missing.add("surface_distance")

    missing.update(
        {
            "material_properties",
            "manufacturing_process",
            "whole_robot_assembly",
            "structural_sanity",
            "visual_review",
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
    material_manufacturing = build_fembot_material_manufacturing_proof(records_dict)
    surface_quality = build_fembot_surface_quality_proof(records_dict, mesh_dir=mesh_dir)
    keepouts = build_fembot_keepout_proof(records_dict, mjcf_path=mjcf_path, mesh_dir=mesh_dir)
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
        "collision_sweep": {
            "ok": bool(collision_sweep.get("ok")),
            "accepted": collision_sweep_accepted,
            "summary": collision_sweep.get("summary", {}),
        },
        "material_manufacturing": {
            "ok": bool(material_manufacturing.get("ok")),
            "accepted": bool(material_manufacturing.get("accepted")),
            "summary": material_manufacturing.get("summary", {}),
        },
        "surface_quality": {
            "ok": bool(surface_quality.get("ok")),
            "accepted": bool(surface_quality.get("accepted")),
            "summary": surface_quality.get("summary", {}),
        },
        "keepouts": {
            "ok": bool(keepouts.get("ok")),
            "accepted": bool(keepouts.get("accepted")),
            "summary": keepouts.get("summary", {}),
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
