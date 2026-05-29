"""Component keepout proof scaffold for ASIMOV fembot thinning."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_surface_quality import measure_surface_quality_for_stl
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS


KEEPOUT_SCHEMA = "asimov-fembot-keepout-proof-v1"


def _parse_floats(raw: str | None) -> list[float]:
    if not raw:
        return []
    return [float(part) for part in raw.split()]


def _mesh_asset_files(root: ET.Element) -> dict[str, str]:
    meshes: dict[str, str] = {}
    for mesh in root.findall(".//asset/mesh"):
        name = mesh.get("name")
        file_name = mesh.get("file")
        if name and file_name:
            meshes[name] = file_name
    return meshes


def _actuators_by_joint(root: ET.Element) -> dict[str, dict[str, Any]]:
    actuators: dict[str, dict[str, Any]] = {}
    actuator_root = root.find("actuator")
    if actuator_root is None:
        return actuators
    for actuator in list(actuator_root):
        joint = actuator.get("joint")
        if not joint:
            continue
        actuators[joint] = {
            "name": actuator.get("name"),
            "tag": actuator.tag,
            "kp": float(actuator.get("kp", "0")),
            "kv": float(actuator.get("kv", "0")),
            "ctrlrange": _parse_floats(actuator.get("ctrlrange")),
        }
    return actuators


def _geom_keepout(body_name: str, geom: ET.Element) -> dict[str, Any]:
    return {
        "name": geom.get("name"),
        "body": body_name,
        "class": geom.get("class"),
        "type": geom.get("type"),
        "fromto": _parse_floats(geom.get("fromto")),
        "pos": _parse_floats(geom.get("pos")),
        "size": _parse_floats(geom.get("size")),
    }


def _body_visual_link(body: ET.Element, mesh_files: dict[str, str]) -> str | None:
    for geom in body.findall("geom"):
        mesh_name = geom.get("mesh")
        if mesh_name and mesh_name in mesh_files:
            return Path(mesh_files[mesh_name]).stem.upper()
    return None


def _walk_bodies(
    body: ET.Element,
    *,
    mesh_files: dict[str, str],
    actuators_by_joint: dict[str, dict[str, Any]],
    records: dict[str, dict[str, Any]],
) -> None:
    body_name = body.get("name") or ""
    link = _body_visual_link(body, mesh_files)
    if link:
        record = records.setdefault(
            link,
            {
                "link": link,
                "body": body_name,
                "joint_keepouts": [],
                "actuator_keepouts": [],
                "collision_keepouts": [],
                "site_keepouts": [],
            },
        )
        for joint in body.findall("joint"):
            joint_name = joint.get("name")
            joint_record = {
                "component_type": "joint_axis",
                "name": joint_name,
                "body": body_name,
                "joint_type": joint.get("type", "hinge"),
                "axis": _parse_floats(joint.get("axis")),
                "range_rad": _parse_floats(joint.get("range")),
                "armature": float(joint.get("armature", "0")),
                "limited": joint.get("limited"),
                "class": joint.get("class"),
            }
            record["joint_keepouts"].append(joint_record)
            actuator = actuators_by_joint.get(joint_name or "")
            if actuator:
                record["actuator_keepouts"].append(
                    {
                        "component_type": "motor_actuator",
                        "joint": joint_name,
                        "body": body_name,
                        "actuator": actuator,
                        "preserve_axis": True,
                        "preserve_ctrlrange": True,
                    }
                )
        for geom in body.findall("geom"):
            geom_class = geom.get("class") or ""
            name = geom.get("name") or ""
            if "collision" in geom_class or "collision" in name:
                record["collision_keepouts"].append(_geom_keepout(body_name, geom))
        for site in body.findall("site"):
            record["site_keepouts"].append(
                {
                    "name": site.get("name"),
                    "body": body_name,
                    "pos": _parse_floats(site.get("pos")),
                    "size": _parse_floats(site.get("size")),
                }
            )

    for child in body.findall("body"):
        _walk_bodies(
            child,
            mesh_files=mesh_files,
            actuators_by_joint=actuators_by_joint,
            records=records,
        )


def _mjcf_link_keepouts(mjcf_path: Path) -> dict[str, Any]:
    tree = ET.parse(mjcf_path)
    root = tree.getroot()
    mesh_files = _mesh_asset_files(root)
    actuators_by_joint = _actuators_by_joint(root)
    records: dict[str, dict[str, Any]] = {}
    worldbody = root.find("worldbody")
    if worldbody is not None:
        for body in worldbody.findall("body"):
            _walk_bodies(
                body,
                mesh_files=mesh_files,
                actuators_by_joint=actuators_by_joint,
                records=records,
            )
    return {
        "mesh_refs": len(mesh_files),
        "position_actuators": len(actuators_by_joint),
        "records": records,
    }


def _source_mesh_envelope(link: str, mesh_dir: Path) -> dict[str, Any] | None:
    path = mesh_dir / f"{link}.STL"
    if not path.is_file():
        return None
    measured = measure_surface_quality_for_stl(path)
    return {
        "component_type": "source_mesh_envelope",
        "source_path": measured["source_path"],
        "source_sha256": measured["source_sha256"],
        "bbox_min_m": measured["bbox_min_m"],
        "bbox_max_m": measured["bbox_max_m"],
        "bbox_extent_m": measured["bbox_extent_m"],
        "area_m2": measured["area_m2"],
    }


def _off_the_shelf_keepouts(group: dict[str, Any]) -> list[dict[str, Any]]:
    keepouts = []
    for candidate in group.get("step_candidates", []):
        if candidate.get("fabrication_class") != "OFF_THE_SHELF":
            continue
        path = Path(str(candidate.get("path")))
        keepouts.append(
            {
                "component_type": "vendor_envelope",
                "source_path": str(path),
                "source_sha256": candidate.get("sha256") or (sha256_file(path) if path.is_file() else None),
                "assembly": candidate.get("assembly"),
                "off_the_shelf_scaled": False,
                "preserve_vendor_envelope": True,
                "preserve_mounting_pattern": True,
            }
        )
    return keepouts


def build_fembot_keepout_proof(
    body_groups: list[dict[str, Any]],
    *,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
) -> dict[str, Any]:
    """Build the current keepout inventory from MJCF and source candidates.

    This proves that the known protected envelopes are discoverable. It is not
    accepted until generated fembot geometry is tested against these envelopes
    and reports positive clearance.
    """
    load = {
        "mjcf_exists": mjcf_path.is_file(),
        "parsed": False,
        "error": None,
    }
    try:
        mjcf = _mjcf_link_keepouts(mjcf_path)
        load["parsed"] = True
    except Exception as exc:
        mjcf = {"mesh_refs": 0, "position_actuators": 0, "records": {}}
        load["error"] = f"{type(exc).__name__}: {exc}"

    records_by_link = mjcf["records"]
    group_records = []
    missing_links = []
    summary_counts = {
        "joint_keepouts": 0,
        "actuator_keepouts": 0,
        "collision_keepouts": 0,
        "site_keepouts": 0,
        "source_mesh_envelopes": 0,
        "off_the_shelf_vendor_envelopes": 0,
    }

    for group in body_groups:
        links = [str(link).upper() for link in group.get("links", [])]
        link_records = []
        group_off_the_shelf = _off_the_shelf_keepouts(group)
        summary_counts["off_the_shelf_vendor_envelopes"] += len(group_off_the_shelf)
        for link in links:
            source = records_by_link.get(link)
            if source is None:
                missing_links.append(link)
                source = {
                    "link": link,
                    "body": None,
                    "joint_keepouts": [],
                    "actuator_keepouts": [],
                    "collision_keepouts": [],
                    "site_keepouts": [],
                }
            envelope = _source_mesh_envelope(link, mesh_dir)
            if envelope:
                summary_counts["source_mesh_envelopes"] += 1
            for key in ("joint_keepouts", "actuator_keepouts", "collision_keepouts", "site_keepouts"):
                summary_counts[key] += len(source[key])
            component_count = (
                len(source["joint_keepouts"])
                + len(source["actuator_keepouts"])
                + len(source["collision_keepouts"])
                + len(source["site_keepouts"])
                + (1 if envelope else 0)
            )
            link_records.append(
                {
                    **source,
                    "source_mesh_envelope": envelope,
                    "component_count": component_count,
                    "minimum_clearance_m": None,
                    "violations": [
                        "generated fembot geometry has not been checked against this link keepout set"
                    ],
                    "off_the_shelf_scaled": False,
                    "accepted": False,
                }
            )
        group_records.append(
            {
                "group": group.get("group"),
                "links": links,
                "link_keepouts": link_records,
                "off_the_shelf_keepouts": group_off_the_shelf,
                "component_count": sum(record["component_count"] for record in link_records)
                + len(group_off_the_shelf),
                "minimum_clearance_m": None,
                "violations": [
                    "generated fembot body group has not been clearance-tested against motors, joints, collision capsules, mesh envelopes, and vendor envelopes"
                ],
                "off_the_shelf_scaled": False,
                "accepted": False,
            }
        )

    ok = bool(load["parsed"] and not missing_links and len(body_groups) > 0)
    return {
        "schema": KEEPOUT_SCHEMA,
        "ok": ok,
        "accepted": False,
        "mjcf_path": str(mjcf_path),
        "mesh_dir": str(mesh_dir),
        "load": load,
        "summary": {
            **summary_counts,
            "body_groups": len(group_records),
            "links": sum(len(group.get("links", [])) for group in group_records),
            "missing_links": sorted(set(missing_links)),
            "mjcf_mesh_refs": mjcf["mesh_refs"],
            "mjcf_position_actuators": mjcf["position_actuators"],
            "minimum_clearance_m": None,
            "accepted": False,
            "acceptance_blocker": (
                "known keepout envelopes are inventoried, but fembot geometry has not "
                "reported clearance against motors, axes, collision capsules, mesh envelopes, "
                "vendor off-the-shelf components, wiring, gears, pulleys, bearings, or fasteners"
            ),
        },
        "body_groups": group_records,
    }


def dump_fembot_keepout_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_keepout_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-keepouts.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_keepout_proof_json(report), encoding="utf-8")
    return output
