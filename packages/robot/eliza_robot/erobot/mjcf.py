"""Generate erobot's MuJoCo model from the parametric spec.

The model is built entirely from primitives (capsule / box / sphere / cylinder /
ellipsoid) so it loads with zero external mesh dependencies. Every body carries
an explicit ``<inertial>`` computed by :mod:`eliza_robot.erobot.mass` (hollow
shell + lumped actuator), so MuJoCo does not infer mass from solid geom volume.

Three model variants come out of the same tree:

  * ``erobot.xml``           — the robot, self-contained, compiles + steps in
                               free space.
  * ``scene.xml``            — includes ``erobot.xml`` + ground plane, light,
                               and a tracking camera (the viewer / standing
                               test).
  * collision variant        — every shell promoted to a collision geom, used by
                               the joint-sweep clearance proof in
                               :mod:`eliza_robot.erobot.validate`.

Foot soles are the only contact geoms in the nominal model, so standing is
stable and there are no spurious self-collisions at the home pose.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from eliza_robot.erobot.mass import ELECTRONICS_KG_TOTAL, BodyMass, compute_body_mass
from eliza_robot.erobot.spec import Body, Geom, RobotSpec, build_spec

ASSETS_DIR = Path(__file__).resolve().parents[2] / "assets" / "profiles" / "erobot"
MJCF_DIR = ASSETS_DIR / "mjcf"

# Per-tier joint dynamics (damping / armature) and position-actuator gain.
_TIER_JOINT = {
    "high": {"damping": 2.0, "armature": 0.10, "kp": 320.0, "frictionloss": 0.4},
    "mid": {"damping": 1.0, "armature": 0.05, "kp": 140.0, "frictionloss": 0.2},
    "low": {"damping": 0.5, "armature": 0.02, "kp": 45.0, "frictionloss": 0.1},
}

_MATERIAL_RGBA = {
    "PA6_GF30": "0.22 0.23 0.25 1",       # dark structural gray
    "PC_ABS": "0.95 0.45 0.13 1",         # eliza accent orange (cosmetic)
    "TPU_SHORE_A95": "0.07 0.07 0.08 1",  # black sole
}


def _fmt(*vals: float) -> str:
    return " ".join(f"{float(v):.6g}" for v in vals)


def _add_assets(root: ET.Element) -> None:
    asset = ET.SubElement(root, "asset")
    for key, rgba in _MATERIAL_RGBA.items():
        reflect = "0.3" if key == "PA6_GF30" else ("0.1" if key == "TPU_SHORE_A95" else "0.2")
        ET.SubElement(asset, "material", {"name": key, "rgba": rgba, "reflectance": reflect})


def _geom_elem(g: Geom, collision: bool) -> ET.Element:
    cls = "collision" if collision else "visual"
    attrs: dict[str, str] = {"name": g.name + ("_col" if collision else ""),
                             "class": cls, "material": g.material_key}
    if g.type in ("capsule", "cylinder"):
        assert g.fromto is not None
        attrs["type"] = g.type
        attrs["fromto"] = _fmt(*g.fromto)
        attrs["size"] = _fmt(g.size[0])
    elif g.type == "box":
        attrs["type"] = "box"
        attrs["size"] = _fmt(*g.size)
        attrs["pos"] = _fmt(*g.pos)
    elif g.type == "sphere":
        attrs["type"] = "sphere"
        attrs["size"] = _fmt(g.size[0])
        attrs["pos"] = _fmt(*g.pos)
    elif g.type == "ellipsoid":
        attrs["type"] = "ellipsoid"
        attrs["size"] = _fmt(*g.size)
        attrs["pos"] = _fmt(*g.pos)
    else:
        raise ValueError(g.type)
    return ET.Element("geom", attrs)


def _inertial_elem(bm: BodyMass) -> ET.Element:
    return ET.Element("inertial", {
        "pos": _fmt(*bm.com),
        "quat": _fmt(*bm.principal_quat),
        "mass": f"{bm.total_mass_kg:.6g}",
        "diaginertia": _fmt(*bm.principal_inertia),
    })


def _emit_body(parent_elem: ET.Element, body: Body, spec: RobotSpec,
               *, all_collision: bool, extra_mass: dict[str, float]) -> None:
    elem = ET.SubElement(parent_elem, "body", {
        "name": body.name, "pos": _fmt(*body.pos),
    })

    if body.is_floating_base:
        ET.SubElement(elem, "freejoint", {"name": "root"})

    bm = compute_body_mass(body)
    # fold lumped electronics into the carrying body's inertial mass
    if body.name in extra_mass:
        bm = _add_point_mass(bm, extra_mass[body.name])
    elem.append(_inertial_elem(bm))

    if body.is_floating_base:
        ET.SubElement(elem, "site", {"name": "imu_site", "pos": "0 0 0", "size": "0.01"})

    if body.joint is not None:
        j = body.joint
        td = _TIER_JOINT[j.tier]
        jattr = {
            "name": j.name,
            "type": "hinge",
            "axis": _fmt(*j.axis),
            "range": _fmt(j.lower_rad, j.upper_rad),
            "damping": f"{td['damping']:g}",
            "armature": f"{td['armature']:g}",
            "frictionloss": f"{td['frictionloss']:g}",
        }
        if j.tendon_driven:
            # toe: a return spring extends it; the cable can only pull it flexed
            jattr["stiffness"] = "3.0"
            jattr["springref"] = "0.0"
            jattr["damping"] = "0.3"
        ET.SubElement(elem, "joint", jattr)

    for g in body.geoms:
        # visual shell
        elem.append(_geom_elem(g, collision=False))
        # collision: soles always; everything else only in the collision variant
        if g.role == "sole" or all_collision:
            elem.append(_geom_elem(g, collision=True))

    _emit_tendon_attachments(elem, body, spec)

    for child in spec.bodies:
        if child.parent == body.name:
            _emit_body(elem, child, spec, all_collision=all_collision, extra_mass=extra_mass)


def _foot_pos_z(spec: RobotSpec) -> float:
    d = spec.dims
    return -(d.ankle_height - d.foot_height / 2.0)


def _emit_tendon_attachments(elem: ET.Element, body, spec: RobotSpec) -> None:
    """Sites + pulley geom for the toe cable drive, in the body's own frame."""
    fz = _foot_pos_z(spec)
    for side in ("left", "right"):
        if body.name == f"{side}_knee":
            ET.SubElement(elem, "site", {"name": f"{side}_toe_cable_shank",
                                         "pos": _fmt(-0.035, 0.0, -0.06), "size": "0.004",
                                         "rgba": "0.1 0.1 0.1 1"})
        elif body.name == f"{side}_ankle_roll":
            pz = fz
            ET.SubElement(elem, "geom", {
                "name": f"{side}_ankle_pulley_geom", "type": "cylinder",
                "fromto": _fmt(-0.045, -0.018, pz, -0.045, 0.018, pz), "size": "0.012",
                "class": "visual", "material": "PA6_GF30", "contype": "0", "conaffinity": "0"})
            ET.SubElement(elem, "site", {"name": f"{side}_toe_pulley_side",
                                         "pos": _fmt(-0.065, 0.0, pz), "size": "0.004",
                                         "rgba": "0 0 0 0"})
        elif body.name == f"{side}_toe":
            # anchor offset below the hinge gives the cable a real moment arm; the
            # ankle pulley turns shank-cable tension into toe articulation.
            ET.SubElement(elem, "site", {"name": f"{side}_toe_cable_anchor",
                                         "pos": _fmt(0.02, 0.0, -0.025), "size": "0.004",
                                         "rgba": "0.1 0.1 0.1 1"})


def _emit_tendons(root: ET.Element, spec: RobotSpec) -> None:
    if not any(j.tendon_driven for j in spec.joints):
        return
    tendon = ET.SubElement(root, "tendon")
    for side in ("left", "right"):
        sp = ET.SubElement(tendon, "spatial", {
            "name": f"{side}_toe_tendon", "width": "0.003",
            "rgba": "0.05 0.05 0.05 1", "limited": "false"})
        ET.SubElement(sp, "site", {"site": f"{side}_toe_cable_shank"})
        ET.SubElement(sp, "geom", {"geom": f"{side}_ankle_pulley_geom",
                                   "sidesite": f"{side}_toe_pulley_side"})
        ET.SubElement(sp, "site", {"site": f"{side}_toe_cable_anchor"})


def _add_point_mass(bm: BodyMass, extra_kg: float) -> BodyMass:
    """Blend an extra point mass at the body origin into an inertial record."""
    from dataclasses import replace

    import numpy as np

    total = bm.total_mass_kg + extra_kg
    com = np.array(bm.com) * bm.total_mass_kg / total  # extra mass at origin
    # parallel-axis the existing inertia from old COM to new COM, add extra term
    d = np.array(bm.com) - com
    # treat principal inertia as already about old COM (diagonal in inertial frame)
    inertia = np.diag(bm.principal_inertia) + bm.total_mass_kg * (
        float(d @ d) * np.eye(3) - np.outer(d, d))
    d_extra = -com
    inertia += extra_kg * (float(d_extra @ d_extra) * np.eye(3) - np.outer(d_extra, d_extra))
    inertia = 0.5 * (inertia + inertia.T)
    evals, _ = np.linalg.eigh(inertia)
    evals = np.clip(evals, 1e-7, None)
    return replace(bm, total_mass_kg=total, com=(float(com[0]), float(com[1]), float(com[2])),
                   principal_inertia=(float(evals[0]), float(evals[1]), float(evals[2])),
                   principal_quat=(1.0, 0.0, 0.0, 0.0))


def _spawn_height(spec: RobotSpec) -> float:
    """Pelvis z so both foot soles rest exactly on the z=0 plane at home."""
    lowest = 0.0
    for b in spec.bodies:
        for g in b.geoms:
            if g.role != "sole":
                continue
            bottom = b.world_pos[2] + g.pos[2] - g.size[2]
            lowest = min(lowest, bottom)
    return spec.pelvis_height_m - lowest


def build_mjcf(spec: RobotSpec | None = None, *, all_collision: bool = False) -> ET.ElementTree:
    spec = spec or build_spec()
    root = ET.Element("mujoco", {"model": "erobot"})
    ET.SubElement(root, "compiler", {"angle": "radian", "autolimits": "true"})
    ET.SubElement(root, "option", {"timestep": "0.002", "integrator": "implicitfast"})

    default = ET.SubElement(root, "default")
    base = ET.SubElement(default, "default", {"class": "erobot"})
    vis = ET.SubElement(base, "default", {"class": "visual"})
    ET.SubElement(vis, "geom", {"group": "2", "contype": "0", "conaffinity": "0", "density": "0"})
    col = ET.SubElement(base, "default", {"class": "collision"})
    ET.SubElement(col, "geom", {"group": "3", "contype": "1", "conaffinity": "1",
                                "condim": "3", "friction": "1.0 0.02 0.001", "density": "0"})

    _add_assets(root)

    worldbody = ET.SubElement(root, "worldbody")
    pelvis = next(b for b in spec.bodies if b.is_floating_base)
    extra_mass = _electronics_distribution()
    spawn_z = _spawn_height(spec)
    _emit_body(worldbody, _with_spawn(pelvis, spawn_z), spec,
               all_collision=all_collision, extra_mass=extra_mass)

    _emit_tendons(root, spec)
    _emit_actuators(root, spec)
    _emit_sensors(root, spec)
    _emit_keyframe(root, spec, spawn_z)

    ET.indent(root, space="  ")
    return ET.ElementTree(root)


def _with_spawn(pelvis: Body, spawn_z: float) -> Body:
    from dataclasses import replace
    return replace(pelvis, pos=(0.0, 0.0, spawn_z))


def _electronics_distribution() -> dict[str, float]:
    # battery + compute + PDB ride in the torso; sensors split torso/head
    return {
        "torso": ELECTRONICS_KG_TOTAL - 0.082,  # all but head sensors
        "head": 0.082,                           # camera + a little wiring
    }


def _emit_actuators(root: ET.Element, spec: RobotSpec) -> None:
    act = ET.SubElement(root, "actuator")
    for j in sorted(spec.joints, key=lambda j: j.index):
        if j.tendon_driven:
            continue  # driven by a tendon actuator below
        td = _TIER_JOINT[j.tier]
        ET.SubElement(act, "position", {
            "name": j.name.replace("_joint", "_act"),
            "joint": j.name,
            "kp": f"{td['kp']:g}",
            "ctrlrange": _fmt(j.lower_rad, j.upper_rad),
            "forcerange": _fmt(-j.torque_nm, j.torque_nm),
        })
    # tendon (cable-over-pulley) actuators — tension only, cables cannot push
    for side in ("left", "right"):
        if any(j.tendon_driven and j.name.startswith(side) for j in spec.joints):
            ET.SubElement(act, "motor", {
                "name": f"{side}_toe_act", "tendon": f"{side}_toe_tendon",
                "ctrlrange": "0 60", "gear": "1"})


def _ctrl_defaults(spec: RobotSpec) -> list[float]:
    """Default ctrl vector in actuator order (joint position acts, then tendons)."""
    ctrl = [j.home_rad for j in sorted(spec.joints, key=lambda j: j.index)
            if not j.tendon_driven]
    for side in ("left", "right"):
        if any(j.tendon_driven and j.name.startswith(side) for j in spec.joints):
            ctrl.append(0.0)
    return ctrl


def _emit_sensors(root: ET.Element, spec: RobotSpec) -> None:
    sensor = ET.SubElement(root, "sensor")
    ET.SubElement(sensor, "framequat", {"name": "imu_quat", "objtype": "body", "objname": "pelvis"})
    ET.SubElement(sensor, "gyro", {"name": "imu_gyro", "site": "imu_site"})
    ET.SubElement(sensor, "accelerometer", {"name": "imu_acc", "site": "imu_site"})
    for j in sorted(spec.joints, key=lambda j: j.index):
        ET.SubElement(sensor, "jointpos", {"name": f"{j.name}_pos", "joint": j.name})
        ET.SubElement(sensor, "jointvel", {"name": f"{j.name}_vel", "joint": j.name})


def _emit_keyframe(root: ET.Element, spec: RobotSpec, spawn_z: float) -> None:
    qpos = [0.0, 0.0, spawn_z, 1.0, 0.0, 0.0, 0.0]
    for j in sorted(spec.joints, key=lambda j: j.index):
        qpos.append(j.home_rad)
    ctrl = _ctrl_defaults(spec)
    kf = ET.SubElement(root, "keyframe")
    ET.SubElement(kf, "key", {"name": "home", "qpos": _fmt(*qpos), "ctrl": _fmt(*ctrl)})


def write_models(spec: RobotSpec | None = None) -> dict[str, Path]:
    spec = spec or build_spec()
    MJCF_DIR.mkdir(parents=True, exist_ok=True)
    (ASSETS_DIR / "mesh").mkdir(parents=True, exist_ok=True)
    (ASSETS_DIR / "mesh" / ".gitkeep").touch()

    tree = build_mjcf(spec)
    robot_path = MJCF_DIR / "erobot.xml"
    tree.write(robot_path, encoding="utf-8", xml_declaration=False)

    scene_path = MJCF_DIR / "scene.xml"
    scene_path.write_text(_scene_xml(), encoding="utf-8")
    return {"robot": robot_path, "scene": scene_path}


def _scene_xml() -> str:
    return """<mujoco model="erobot_scene">
  <include file="erobot.xml"/>
  <statistic center="0 0 0.8" extent="2.0"/>
  <visual>
    <headlight diffuse="0.6 0.6 0.6" ambient="0.3 0.3 0.3" specular="0 0 0"/>
    <rgba haze="0.15 0.25 0.35 1"/>
    <global azimuth="120" elevation="-20" offwidth="640" offheight="960"/>
  </visual>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="512"/>
    <texture name="groundplane" type="2d" builtin="checker" mark="edge"
             rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8"
             width="300" height="300"/>
    <material name="groundplane" texture="groundplane" texuniform="true"
              texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3.0" dir="0 0 -1" directional="true"/>
    <geom name="floor" type="plane" size="0 0 0.05" material="groundplane"
          contype="1" conaffinity="1" condim="3" friction="1.0 0.02 0.001"/>
    <camera name="track" mode="trackcom" pos="0 -2.5 1.2" xyaxes="1 0 0 0 0.4 1"/>
  </worldbody>
</mujoco>
"""


if __name__ == "__main__":
    paths = write_models()
    for k, p in paths.items():
        print(f"{k}: {p}")
