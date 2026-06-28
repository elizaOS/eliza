"""Generate a profile URDF from the ASIMOV-1 MJCF hierarchy."""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from pathlib import Path

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_GENERATED_URDF,
)


def _floats(raw: str | None, *, default: tuple[float, ...]) -> tuple[float, ...]:
    if raw is None or raw.strip() == "":
        return default
    return tuple(float(part) for part in raw.split())


def _fmt(values: tuple[float, ...]) -> str:
    return " ".join(f"{value:.10g}" for value in values)


def _quat_to_rpy(quat: tuple[float, ...]) -> tuple[float, float, float]:
    if len(quat) != 4:
        return (0.0, 0.0, 0.0)
    w, x, y, z = quat
    sinr_cosp = 2 * (w * x + y * z)
    cosr_cosp = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)
    sinp = 2 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
    siny_cosp = 2 * (w * z + x * y)
    cosy_cosp = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    return (roll, pitch, yaw)


def _set_origin(target: ET.Element, source: ET.Element) -> None:
    pos = _floats(source.get("pos"), default=(0.0, 0.0, 0.0))
    quat = _floats(source.get("quat"), default=(1.0, 0.0, 0.0, 0.0))
    ET.SubElement(target, "origin", {"xyz": _fmt(pos), "rpy": _fmt(_quat_to_rpy(quat))})


def _mesh_files(root: ET.Element) -> dict[str, str]:
    files: dict[str, str] = {}
    for mesh in root.findall("./asset/mesh"):
        name = mesh.get("name")
        filename = mesh.get("file")
        if name and filename:
            files[name] = filename
    return files


def _append_inertial(link: ET.Element, body: ET.Element) -> None:
    source = body.find("inertial")
    if source is None:
        return
    mass = source.get("mass")
    if mass is None:
        return
    inertial = ET.SubElement(link, "inertial")
    _set_origin(inertial, source)
    ET.SubElement(inertial, "mass", {"value": mass})
    full = _floats(source.get("fullinertia"), default=())
    diag = _floats(source.get("diaginertia"), default=())
    if len(full) == 6:
        ixx, iyy, izz, ixy, ixz, iyz = full
    elif len(diag) == 3:
        ixx, iyy, izz = diag
        ixy = ixz = iyz = 0.0
    else:
        ixx = iyy = izz = 1e-6
        ixy = ixz = iyz = 0.0
    ET.SubElement(
        inertial,
        "inertia",
        {
            "ixx": f"{ixx:.10g}",
            "ixy": f"{ixy:.10g}",
            "ixz": f"{ixz:.10g}",
            "iyy": f"{iyy:.10g}",
            "iyz": f"{iyz:.10g}",
            "izz": f"{izz:.10g}",
        },
    )


def _append_visuals(link: ET.Element, body: ET.Element, meshes: dict[str, str]) -> int:
    count = 0
    for geom in body.findall("geom"):
        if geom.get("type") != "mesh":
            continue
        mesh_name = geom.get("mesh")
        mesh_file = meshes.get(mesh_name or "")
        if mesh_file is None:
            continue
        visual = ET.SubElement(link, "visual", {"name": geom.get("name", f"{body.get('name')}_visual")})
        _set_origin(visual, geom)
        geometry = ET.SubElement(visual, "geometry")
        ET.SubElement(geometry, "mesh", {"filename": f"meshes/{mesh_file}"})
        count += 1
    return count


def _append_joint(robot: ET.Element, body: ET.Element, parent_link: str, child_link: str) -> int:
    joints = [joint for joint in body.findall("joint") if joint.get("type", "hinge") == "hinge"]
    if not joints:
        fixed = ET.SubElement(robot, "joint", {"name": f"{parent_link}_to_{child_link}", "type": "fixed"})
        ET.SubElement(fixed, "parent", {"link": parent_link})
        ET.SubElement(fixed, "child", {"link": child_link})
        _set_origin(fixed, body)
        return 0

    joint = joints[0]
    name = joint.get("name", f"{parent_link}_to_{child_link}")
    urdf_joint = ET.SubElement(robot, "joint", {"name": name, "type": "revolute"})
    ET.SubElement(urdf_joint, "parent", {"link": parent_link})
    ET.SubElement(urdf_joint, "child", {"link": child_link})
    _set_origin(urdf_joint, body)
    ET.SubElement(urdf_joint, "axis", {"xyz": _fmt(_floats(joint.get("axis"), default=(1.0, 0.0, 0.0)))})
    lo, hi = _floats(joint.get("range"), default=(-3.14159, 3.14159))
    effort = "20" if name in ASIMOV1_FIRMWARE_JOINT_ORDER else "5"
    velocity = "20" if name in ASIMOV1_FIRMWARE_JOINT_ORDER else "10"
    ET.SubElement(
        urdf_joint,
        "limit",
        {"lower": f"{lo:.10g}", "upper": f"{hi:.10g}", "effort": effort, "velocity": velocity},
    )
    return 1


def generate_asimov1_urdf(
    *,
    source_xml: Path = ASIMOV1_GENERATED_MJCF,
    output_urdf: Path = ASIMOV1_GENERATED_URDF,
) -> Path:
    """Write a visual/kinematic URDF derived from the generated ASIMOV MJCF.

    MuJoCo remains the dynamics authority. This URDF preserves body hierarchy,
    inertials, visual mesh references, and revolute joint limits for tools that
    require URDF input.
    """
    tree = ET.parse(source_xml)
    mjcf_root = tree.getroot()
    worldbody = mjcf_root.find("worldbody")
    if worldbody is None:
        raise ValueError(f"ASIMOV MJCF has no worldbody: {source_xml}")
    root_body = next((body for body in worldbody.findall("body")), None)
    if root_body is None:
        raise ValueError(f"ASIMOV MJCF has no root body: {source_xml}")

    meshes = _mesh_files(mjcf_root)
    robot = ET.Element(
        "robot",
        {
            "name": "asimov-1",
            "mjcf_source": str(source_xml),
            "note": "Generated from ASIMOV-1 MJCF; MuJoCo XML remains dynamics authority.",
        },
    )
    stats = {"links": 0, "joints": 0, "visuals": 0}

    def walk(body: ET.Element, parent: str | None) -> None:
        name = body.get("name")
        if not name:
            raise ValueError("ASIMOV MJCF body is missing a name")
        link = ET.SubElement(robot, "link", {"name": name})
        stats["links"] += 1
        _append_inertial(link, body)
        stats["visuals"] += _append_visuals(link, body, meshes)
        if parent is not None:
            stats["joints"] += _append_joint(robot, body, parent, name)
        for child in body.findall("body"):
            walk(child, name)

    walk(root_body, None)
    robot.append(ET.Comment(f"links={stats['links']} joints={stats['joints']} visuals={stats['visuals']}"))
    ET.indent(ET.ElementTree(robot), space="  ")
    output_urdf.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(robot).write(output_urdf, encoding="utf-8", xml_declaration=True)
    return output_urdf
