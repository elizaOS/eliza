"""Generate a URDF for erobot from the parametric spec.

URDF is the secondary asset (IsaacLab / IsaacSim / ROS / motion planners); the
MuJoCo MJCF is the validated primary model. URDF lacks capsule and ellipsoid
primitives, so capsules/cylinders map to ``<cylinder>`` and ellipsoids to a
bounding ``<box>``. Inertia comes straight from the shared mass model
(full COM-frame tensor), so masses and inertias match the MJCF.

The pelvis is the root link with no parent joint — the physics engine treats it
as the free-floating base, the standard humanoid URDF convention.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from eliza_robot.erobot.mass import ELECTRONICS_KG_TOTAL, compute_body_mass
from eliza_robot.erobot.mjcf import _MATERIAL_RGBA, ASSETS_DIR
from eliza_robot.erobot.spec import Body, Geom, RobotSpec, build_spec

_EXTRA_MASS = {"torso": ELECTRONICS_KG_TOTAL - 0.082, "head": 0.082}


def _fmt(*v: float) -> str:
    return " ".join(f"{float(x):.6g}" for x in v)


def _capsule_len_mid(fromto: tuple[float, ...]) -> tuple[float, tuple[float, float, float]]:
    import numpy as np
    p0 = np.array(fromto[:3])
    p1 = np.array(fromto[3:])
    length = float(np.linalg.norm(p1 - p0))
    mid = tuple((p0 + p1) / 2.0)
    return length, mid


def _geometry(parent: ET.Element, g: Geom) -> tuple[ET.Element, tuple[float, float, float]]:
    geom = ET.SubElement(parent, "geometry")
    if g.type in ("capsule", "cylinder"):
        assert g.fromto is not None
        length, mid = _capsule_len_mid(g.fromto)
        ET.SubElement(geom, "cylinder", {"radius": _fmt(g.size[0]), "length": _fmt(length)})
        return geom, mid
    if g.type == "box":
        ET.SubElement(geom, "box", {"size": _fmt(2 * g.size[0], 2 * g.size[1], 2 * g.size[2])})
        return geom, g.pos
    if g.type == "sphere":
        ET.SubElement(geom, "sphere", {"radius": _fmt(g.size[0])})
        return geom, g.pos
    if g.type == "ellipsoid":
        ET.SubElement(geom, "box", {"size": _fmt(2 * g.size[0], 2 * g.size[1], 2 * g.size[2])})
        return geom, g.pos
    raise ValueError(g.type)


def _link(robot: ET.Element, body: Body) -> None:
    link = ET.SubElement(robot, "link", {"name": body.name})
    bm = compute_body_mass(body)
    mass = bm.total_mass_kg + _EXTRA_MASS.get(body.name, 0.0)

    inertial = ET.SubElement(link, "inertial")
    ET.SubElement(inertial, "origin", {"xyz": _fmt(*bm.com), "rpy": "0 0 0"})
    ET.SubElement(inertial, "mass", {"value": _fmt(mass)})
    ixx, iyy, izz, ixy, ixz, iyz = bm.inertia_com
    ET.SubElement(inertial, "inertia", {
        "ixx": _fmt(ixx), "iyy": _fmt(iyy), "izz": _fmt(izz),
        "ixy": _fmt(ixy), "ixz": _fmt(ixz), "iyz": _fmt(iyz),
    })

    for g in body.geoms:
        visual = ET.SubElement(link, "visual")
        _, origin = _geometry(visual, g)
        ET.SubElement(visual, "origin", {"xyz": _fmt(*origin), "rpy": "0 0 0"})
        mat = ET.SubElement(visual, "material", {"name": g.material_key})
        ET.SubElement(mat, "color", {"rgba": _MATERIAL_RGBA[g.material_key]})
        collision = ET.SubElement(link, "collision")
        _geometry(collision, g)
        ET.SubElement(collision, "origin", {"xyz": _fmt(*origin), "rpy": "0 0 0"})


def _joint(robot: ET.Element, body: Body) -> None:
    j = body.joint
    assert j is not None and body.parent is not None
    joint = ET.SubElement(robot, "joint", {"name": j.name, "type": "revolute"})
    ET.SubElement(joint, "parent", {"link": body.parent})
    ET.SubElement(joint, "child", {"link": body.name})
    ET.SubElement(joint, "origin", {"xyz": _fmt(*body.pos), "rpy": "0 0 0"})
    ET.SubElement(joint, "axis", {"xyz": _fmt(*j.axis)})
    ET.SubElement(joint, "limit", {
        "lower": _fmt(j.lower_rad), "upper": _fmt(j.upper_rad),
        "effort": _fmt(j.torque_nm), "velocity": _fmt(j.velocity_max_rad_s),
    })


def build_urdf(spec: RobotSpec | None = None) -> ET.ElementTree:
    spec = spec or build_spec()
    robot = ET.Element("robot", {"name": "erobot"})
    for body in spec.bodies:
        _link(robot, body)
    for body in spec.bodies:
        if body.joint is not None:
            _joint(robot, body)
    ET.indent(robot, space="  ")
    return ET.ElementTree(robot)


def write_urdf(spec: RobotSpec | None = None) -> Path:
    spec = spec or build_spec()
    out = ASSETS_DIR / "erobot.urdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    build_urdf(spec).write(out, encoding="utf-8", xml_declaration=True)
    return out


if __name__ == "__main__":
    print(write_urdf())
