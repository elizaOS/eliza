"""Internal-component catalog for erobot — every part inside the shells.

For each structural body this enumerates the real internal hardware: the
off-the-shelf actuator motor (sized to its datasheet envelope), its output
bearing, and the trunk electronics (battery, compute, power-distribution,
IMU, head camera, wiring harness). Foot tendon/pulley hardware is added by the
articulation step. Each component carries a body-frame pose and a mesh
descriptor so the fit / collision / manifold proofs can mesh and place it.

Motor envelopes (datasheet-derived):
  high  CubeMars AK80-64        — Ø98 x 40 mm  cylinder
  mid   CubeMars AK70-10        — Ø80 x 35 mm  cylinder
  low   Robotis Dynamixel XM540 — 33.5 x 58.5 x 44 mm  box
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from eliza_robot.erobot.spec import ACTUATORS, RobotSpec, build_spec

Vec3 = tuple[float, float, float]

# (diameter, axial_height) for cylindrical QDD motors
_MOTOR_CYL = {
    "high": (0.098, 0.040),
    "mid": (0.080, 0.035),
}
# Dynamixel XM540 box envelope (w, l, h) — long axis along the joint axis
_MOTOR_BOX_LOW = (0.0335, 0.0585, 0.044)

# THK RB5013 crossed-roller: Ø50 bore x Ø80 OD x 13 mm, ~0.27 kg
_CROSSED_ROLLER = {"r_in": 0.025, "r_out": 0.040, "h": 0.013, "mass": 0.27}


@dataclass(frozen=True)
class Component:
    name: str
    body: str               # parent structural body
    kind: str               # motor|bearing|battery|compute|pdb|imu|camera|harness|pulley|cable
    gtype: str              # mesh primitive type
    size: tuple[float, ...]
    pose: dict[str, Any] = field(default_factory=dict)   # {"pos":..} or {"fromto":..}
    mass_kg: float = 0.0
    note: str = ""


def _axis_fromto(axis: Vec3, height: float, center: Vec3 = (0.0, 0.0, 0.0)) -> dict[str, Any]:
    half = [a * height / 2.0 for a in axis]
    p0 = tuple(center[i] - half[i] for i in range(3))
    p1 = tuple(center[i] + half[i] for i in range(3))
    return {"fromto": (*p0, *p1)}


def build_components(spec: RobotSpec | None = None) -> list[Component]:
    spec = spec or build_spec()
    comps: list[Component] = []

    for body in spec.bodies:
        if body.joint is None or body.actuator_tier is None:
            continue
        if body.joint.tendon_driven:
            continue  # toe has no motor in the link; driven by a remote winch + pulley
        tier = body.actuator_tier
        axis = body.joint.axis
        if tier in _MOTOR_CYL:
            dia, h = _MOTOR_CYL[tier]
            comps.append(Component(
                name=f"{body.name}_motor", body=body.name, kind="motor",
                gtype="cylinder", size=(dia / 2.0,),
                pose=_axis_fromto(axis, h),
                mass_kg=ACTUATORS[tier].mass_kg,
                note=f"{tier}-tier QDD motor, axis along joint"))
        else:
            w, length, hh = _MOTOR_BOX_LOW
            # the neck is a short tube above the joint origin; seat its motor
            # mid-tube so it is fully housed rather than half below the base.
            pos = (0.0, 0.0, 0.035) if body.name == "neck" else (0.0, 0.0, 0.0)
            comps.append(Component(
                name=f"{body.name}_motor", body=body.name, kind="motor",
                gtype="box", size=(w / 2.0, length / 2.0, hh / 2.0),
                pose={"pos": pos},
                mass_kg=ACTUATORS[tier].mass_kg,
                note="Dynamixel XM540 smart servo"))

        # high-tier joints get an added crossed-roller output bearing
        if tier == "high":
            b = _CROSSED_ROLLER
            comps.append(Component(
                name=f"{body.name}_bearing", body=body.name, kind="bearing",
                gtype="annulus", size=(b["r_in"], b["r_out"], b["h"]),
                pose=_axis_fromto(axis, b["h"]),
                mass_kg=b["mass"],
                note="THK RB5013 crossed-roller output bearing"))

    # --- trunk electronics (inside the torso cavity, stacked along z) ---
    comps += [
        Component("battery_pack", "torso", "battery", "box",
                  (0.075, 0.050, 0.030), {"pos": (0.0, 0.0, 0.055)}, 2.2,
                  "custom 13S Li-ion ~400 Wh"),
        Component("compute_jetson", "torso", "compute", "box",
                  (0.050, 0.040, 0.015), {"pos": (0.0, 0.0, 0.150)}, 0.18,
                  "Jetson Orin Nano + carrier"),
        Component("power_distribution", "torso", "pdb", "box",
                  (0.050, 0.040, 0.012), {"pos": (0.0, 0.0, 0.210)}, 0.30,
                  "PDB + DC-DC buck stages"),
        Component("spine_harness", "torso", "harness", "cylinder",
                  (0.015,), {"fromto": (0.0, 0.10, 0.020, 0.0, 0.10, 0.380)}, 0.60,
                  "main wiring bundle routed up the left side, clear of the battery stack"),
    ]
    # IMU at the pelvis origin (matches the MJCF imu_site)
    comps.append(Component("imu_bmi088", "pelvis", "imu", "box",
                           (0.011, 0.008, 0.004), {"pos": (0.0, 0.0, 0.0)}, 0.01,
                           "Bosch BMI088 on a small PCB"))
    # head camera at the front of the head shell
    comps.append(Component("head_camera", "head", "camera", "box",
                           (0.038, 0.012, 0.012), {"pos": (0.040, 0.0, 0.085)}, 0.072,
                           "Intel RealSense D435i behind the face"))

    # --- toe cable drive: winch in the shank, pulley at the ankle (per foot) ---
    for side in ("left", "right"):
        comps.append(Component(
            f"{side}_toe_winch", f"{side}_knee", "motor", "box",
            (0.0168, 0.0293, 0.022), {"pos": (0.0, 0.0, -0.12)}, 0.17,
            "toe-flexor cable winch (XM540 class) mounted on the shank"))
        comps.append(Component(
            f"{side}_ankle_pulley", f"{side}_ankle_roll", "pulley", "cylinder",
            (0.012,), {"fromto": (-0.045, -0.018, -0.0475, -0.045, 0.018, -0.0475)}, 0.03,
            "cable pulley turning the toe tendon, mounted behind the ankle motor"))
    return comps


def components_by_body(spec: RobotSpec | None = None) -> dict[str, list[Component]]:
    spec = spec or build_spec()
    out: dict[str, list[Component]] = {}
    for c in build_components(spec):
        out.setdefault(c.body, []).append(c)
    return out


if __name__ == "__main__":
    spec = build_spec()
    comps = build_components(spec)
    kinds: dict[str, int] = {}
    mass = 0.0
    for c in comps:
        kinds[c.kind] = kinds.get(c.kind, 0) + 1
        mass += c.mass_kg
    print(f"erobot internal components: {len(comps)} parts, {mass:.2f} kg catalog mass")
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"  {k:10s} x{n}")
