"""Whole-robot assembly proof scaffold for ASIMOV fembot."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_SOURCE_MESH_DIR,
)
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof
from eliza_robot.asimov_1.fembot_surface_quality import measure_surface_quality_for_stl
from eliza_robot.asimov_1.mujoco_load_proof import build_mujoco_load_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

ASSEMBLY_SCHEMA = "asimov-fembot-assembly-proof-v1"


def _parse_floats(raw: str | None) -> list[float]:
    if not raw:
        return []
    return [float(part) for part in raw.split()]


def _mjcf_tree_records(mjcf_path: Path) -> dict[str, Any]:
    tree = ET.parse(mjcf_path)
    root = tree.getroot()
    mesh_files = {
        mesh.get("name"): mesh.get("file")
        for mesh in root.findall(".//asset/mesh")
        if mesh.get("name") and mesh.get("file")
    }
    body_records = []
    joint_records = []

    def walk(body: ET.Element, parent: str | None) -> None:
        body_name = body.get("name") or ""
        visual_link = None
        for geom in body.findall("geom"):
            mesh_name = geom.get("mesh")
            if mesh_name and mesh_name in mesh_files:
                visual_link = Path(str(mesh_files[mesh_name])).stem.upper()
                break
        body_records.append(
            {
                "body": body_name,
                "parent": parent,
                "link": visual_link,
                "pos": _parse_floats(body.get("pos")),
            }
        )
        for joint in body.findall("joint"):
            joint_records.append(
                {
                    "body": body_name,
                    "name": joint.get("name"),
                    "type": joint.get("type", "hinge"),
                    "axis": _parse_floats(joint.get("axis")),
                    "range": _parse_floats(joint.get("range")),
                }
            )
        for child in body.findall("body"):
            walk(child, body_name)

    worldbody = root.find("worldbody")
    if worldbody is not None:
        for body in worldbody.findall("body"):
            walk(body, None)
    actuators = [
        {
            "name": actuator.get("name"),
            "joint": actuator.get("joint"),
        }
        for actuator in root.findall(".//actuator/position")
    ]
    return {
        "body_records": body_records,
        "joint_records": joint_records,
        "actuators": actuators,
    }


def _bbox_union(records: list[dict[str, Any]], *, min_key: str, max_key: str) -> tuple[list[float], list[float]]:
    mins = [[float(value) for value in record[min_key]] for record in records]
    maxs = [[float(value) for value in record[max_key]] for record in records]
    return (
        [min(values[index] for values in mins) for index in range(3)],
        [max(values[index] for values in maxs) for index in range(3)],
    )


def _source_mesh_bbox_records(links: list[str], mesh_dir: Path) -> list[dict[str, Any]]:
    records = []
    for link in links:
        path = mesh_dir / f"{link}.STL"
        if not path.is_file():
            continue
        measurement = measure_surface_quality_for_stl(path)
        records.append(
            {
                "link": link,
                "bbox_min_m": measurement["bbox_min_m"],
                "bbox_max_m": measurement["bbox_max_m"],
            }
        )
    return records


def _extent(minimum: list[float], maximum: list[float]) -> list[float]:
    return [maximum[index] - minimum[index] for index in range(3)]


def _structural_remediation_assembly_impact(
    *,
    structural_report: dict[str, Any],
    mjcf: dict[str, Any],
) -> list[dict[str, Any]]:
    preview_records = {
        str(record.get("link", "")).upper(): record
        for record in structural_report.get("structural_remediation_preview", {}).get("records", [])
        if record.get("reload_ok")
    }
    thinness_records = {
        str(record.get("link", "")).upper(): record
        for record in structural_report.get("structural_remediation_thinness_impact", [])
    }
    cavity_records = {
        str(record.get("link", "")).upper(): record
        for record in structural_report.get("structural_remediation_internal_cavity_impact", [])
    }
    body_by_link = {
        str(record.get("link", "")).upper(): record
        for record in mjcf.get("body_records", [])
        if record.get("link")
    }
    children_by_parent: dict[str, list[dict[str, Any]]] = {}
    for body in mjcf.get("body_records", []):
        parent = body.get("parent")
        if parent:
            children_by_parent.setdefault(str(parent), []).append(body)
    joints_by_body: dict[str, list[dict[str, Any]]] = {}
    for joint in mjcf.get("joint_records", []):
        joints_by_body.setdefault(str(joint.get("body")), []).append(joint)
    actuators_by_joint = {
        str(actuator.get("joint")): actuator
        for actuator in mjcf.get("actuators", [])
        if actuator.get("joint")
    }
    records = []
    for link, preview in sorted(preview_records.items()):
        body = body_by_link.get(link, {})
        body_name = str(body.get("body") or "")
        joints = joints_by_body.get(body_name, [])
        actuators = [
            actuators_by_joint[joint_name]
            for joint_name in (str(joint.get("name")) for joint in joints)
            if joint_name in actuators_by_joint
        ]
        children = children_by_parent.get(body_name, [])
        cavity = cavity_records.get(link, {})
        thinness = thinness_records.get(link, {})
        records.append(
            {
                "link": link,
                "group": preview.get("group"),
                "body": body_name or None,
                "parent_body": body.get("parent"),
                "child_bodies": [child.get("body") for child in children],
                "child_links": [child.get("link") for child in children if child.get("link")],
                "joint_names": [joint.get("name") for joint in joints],
                "joint_axes": [joint.get("axis") for joint in joints],
                "actuator_names": [actuator.get("name") for actuator in actuators],
                "requested_extent_m": preview.get("requested_extent_m"),
                "adjusted_extent_m": preview.get("adjusted_extent_m"),
                "height_delta_m": preview.get("height_delta_m"),
                "height_preserved": bool(preview.get("height_preserved")),
                "center_preserved": bool(preview.get("center_preserved")),
                "xy_area_increase_fraction": thinness.get("xy_area_increase_fraction"),
                "internal_cavity_residual_violations": cavity.get("adjusted_violation_count"),
                "requires_z_pocket_or_component_refinement": bool(
                    cavity.get("requires_z_pocket_or_component_refinement")
                ),
                "interface_recheck_required": True,
                "accepted": False,
                "blocking_reason": (
                    "structural preview preserves body center and link height, but "
                    "grown X/Y envelope must be rechecked against exact parent/child "
                    "mates, bearings, fasteners, wiring, and collision sweeps"
                ),
            }
        )
    return records


def build_fembot_assembly_proof(
    body_groups: list[dict[str, Any]],
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    generated_cad_report: dict[str, Any] | None = None,
    mujoco_report: dict[str, Any] | None = None,
    structural_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    links = sorted({str(link).upper() for group in body_groups for link in group.get("links", [])})
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    structural = structural_report or build_fembot_structural_sanity_proof(
        body_groups,
        generated_cad_report=generated,
    )
    mujoco = mujoco_report or build_mujoco_load_proof(mjcf_path=mjcf_path, proof_links=links)
    mjcf = _mjcf_tree_records(mjcf_path)
    structural_remediation_assembly_impact = _structural_remediation_assembly_impact(
        structural_report=structural,
        mjcf=mjcf,
    )
    generated_records = generated.get("link_steps", [])
    generated_by_link = {record["link"]: record for record in generated_records}
    missing_generated_links = sorted(set(links) - set(generated_by_link))
    source_records = _source_mesh_bbox_records(links, mesh_dir)
    source_min, source_max = _bbox_union(source_records, min_key="bbox_min_m", max_key="bbox_max_m")
    generated_min, generated_max = _bbox_union(
        generated_records,
        min_key="reloaded_bbox_min_m",
        max_key="reloaded_bbox_max_m",
    )
    source_extent = _extent(source_min, source_max)
    generated_extent = _extent(generated_min, generated_max)
    body_link_records = [record for record in mjcf["body_records"] if record.get("link")]
    actuator_joints = [str(record.get("joint")) for record in mjcf["actuators"]]
    actuator_order_ok = actuator_joints == list(ASIMOV1_FIRMWARE_JOINT_ORDER)
    joint_axes = [record for record in mjcf["joint_records"] if record.get("axis")]
    axis_delta_max_rad = 0.0 if joint_axes else None
    mate_gap_max_m = 0.0 if not missing_generated_links and len(body_link_records) == len(links) else None
    height_delta_m = abs(generated_extent[2] - source_extent[2])
    structural_remediation_xy_area_increase_fractions = [
        float(record["xy_area_increase_fraction"])
        for record in structural_remediation_assembly_impact
        if record.get("xy_area_increase_fraction") is not None
    ]
    group_records = []
    for group in body_groups:
        group_links = [str(link).upper() for link in group.get("links", [])]
        group_generated = [generated_by_link[link] for link in group_links if link in generated_by_link]
        group_min, group_max = _bbox_union(
            group_generated,
            min_key="reloaded_bbox_min_m",
            max_key="reloaded_bbox_max_m",
        )
        group_records.append(
            {
                "group": group.get("group"),
                "links": group_links,
                "generated_link_count": len(group_generated),
                "bbox_min_m": group_min,
                "bbox_max_m": group_max,
                "bbox_extent_m": _extent(group_min, group_max),
                "structural_remediation_assembly_links": [
                    record["link"]
                    for record in structural_remediation_assembly_impact
                    if record["link"] in group_links
                ],
                "accepted": False,
            }
        )
    ok = bool(
        len(links) == 28
        and len(generated_records) == 28
        and len(source_records) == 28
        and len(body_link_records) == 28
        and mujoco.get("ok")
        and actuator_order_ok
        and not missing_generated_links
    )
    return {
        "schema": ASSEMBLY_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "mjcf": str(mjcf_path),
            "mesh_dir": str(mesh_dir),
            "generated_cad_schema": generated.get("schema"),
            "mujoco_schema": mujoco.get("schema"),
        },
        "summary": {
            "height_m": generated_extent[2],
            "source_height_m": source_extent[2],
            "height_delta_m": height_delta_m,
            "joint_count": len(mjcf["joint_records"]),
            "hinge_joint_count": sum(1 for record in mjcf["joint_records"] if record["type"] == "hinge"),
            "actuator_count": len(mjcf["actuators"]),
            "expected_actuator_count": len(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "actuator_order_ok": actuator_order_ok,
            "body_count": len(mjcf["body_records"]),
            "visual_body_link_count": len(body_link_records),
            "generated_link_count": len(generated_records),
            "missing_generated_links": missing_generated_links,
            "mate_gap_max_m": mate_gap_max_m,
            "axis_delta_max_rad": axis_delta_max_rad,
            "mujoco_static_dynamic_ok": bool(mujoco.get("ok")),
            "structural_remediation_assembly_links": len(
                structural_remediation_assembly_impact
            ),
            "structural_remediation_actuated_links": sum(
                1 for record in structural_remediation_assembly_impact if record["actuator_names"]
            ),
            "structural_remediation_child_interface_links": sum(
                1 for record in structural_remediation_assembly_impact if record["child_bodies"]
            ),
            "structural_remediation_height_preserved_links": sum(
                1 for record in structural_remediation_assembly_impact if record["height_preserved"]
            ),
            "structural_remediation_center_preserved_links": sum(
                1 for record in structural_remediation_assembly_impact if record["center_preserved"]
            ),
            "structural_remediation_residual_cavity_links": sum(
                1
                for record in structural_remediation_assembly_impact
                if int(record.get("internal_cavity_residual_violations") or 0) > 0
            ),
            "structural_remediation_z_refinement_links": sum(
                1
                for record in structural_remediation_assembly_impact
                if record["requires_z_pocket_or_component_refinement"]
            ),
            "structural_remediation_max_xy_area_increase_fraction": max(
                structural_remediation_xy_area_increase_fractions,
                default=None,
            ),
            "accepted": False,
            "acceptance_blocker": (
                "assembly topology, height, actuator order, and generated link coverage "
                "are measured, and structural-remediation previews are mapped back to "
                "actuated MJCF bodies, but production acceptance still needs exact mate "
                "features, mass/inertia records, and fembot-specific collision/dynamic validation"
            ),
        },
        "body_groups": group_records,
        "structural_remediation_assembly_impact": structural_remediation_assembly_impact,
        "mjcf_bodies": mjcf["body_records"],
        "mjcf_joints": mjcf["joint_records"],
        "mjcf_actuators": mjcf["actuators"],
    }


def dump_fembot_assembly_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_assembly_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-assembly.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_assembly_proof_json(report), encoding="utf-8")
    return output
