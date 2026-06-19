"""Mass + inertia model for erobot.

Each structural link is a *hollow* injection-molded shell, so its mass is the
shell-surface area times the wall thickness times the material density — not the
solid volume. The off-the-shelf actuator (plus its bearing + fasteners) is
lumped as a point mass at the joint (the body origin).

Per body we sum every geom's mass + inertia (each is axis-aligned in the body
frame, so its inertia tensor is diagonal about its own centroid) plus the
actuator point mass, shift everything to the body centre of mass via the
parallel-axis theorem, then diagonalize the resulting tensor. The output is the
``(mass, com, principal_inertia, principal_quat)`` tuple MuJoCo wants in an
``<inertial>`` element.

Foot soles (``role="sole"``) are modeled solid (a solid TPU pad), everything
else as a thin shell.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from eliza_robot.erobot.spec import MATERIALS, Body, Geom, RobotSpec, build_spec

Vec3 = tuple[float, float, float]


# ---------------------------------------------------------------------------
# Per-geom mass + local-frame diagonal inertia (about the geom centroid)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GeomMass:
    name: str
    mass_kg: float
    volume_m3: float
    surface_area_m2: float
    centroid: Vec3                 # in body frame
    inertia_diag: Vec3             # principal moments about centroid, body axes
    inertia_axis: str              # which body axis the long axis points along


def _capsule_length_axis(fromto: tuple[float, ...]) -> tuple[float, Vec3, str]:
    p0 = np.array(fromto[:3], dtype=float)
    p1 = np.array(fromto[3:], dtype=float)
    d = p1 - p0
    length = float(np.linalg.norm(d))
    centroid = tuple((p0 + p1) / 2.0)
    # all erobot capsules/cylinders run along a body axis; pick the dominant one
    axis = "xyz"[int(np.argmax(np.abs(d)))] if length > 0 else "z"
    return length, centroid, axis


def _shell_geom_mass(g: Geom) -> GeomMass:
    mat = MATERIALS[g.material_key]
    rho = mat.density_kg_m3
    wall = g.wall_mm / 1000.0

    if g.type == "capsule":
        assert g.fromto is not None
        r = g.size[0]
        L, c, axis = _capsule_length_axis(g.fromto)
        area = 2.0 * math.pi * r * L + 4.0 * math.pi * r * r
        mass = area * wall * rho
        # thin cylindrical shell + hemispherical caps, about centroid
        i_axial = mass * r * r
        i_trans = mass * (0.5 * r * r + L * L / 12.0)
        diag = {"x": (i_axial, i_trans, i_trans),
                "y": (i_trans, i_axial, i_trans),
                "z": (i_trans, i_trans, i_axial)}[axis]
        vol = math.pi * r * r * L + 4.0 / 3.0 * math.pi * r ** 3
        return GeomMass(g.name, mass, vol, area, c, diag, axis)

    if g.type == "cylinder":
        assert g.fromto is not None
        r = g.size[0]
        L, c, axis = _capsule_length_axis(g.fromto)
        area = 2.0 * math.pi * r * L + 2.0 * math.pi * r * r
        mass = area * wall * rho
        i_axial = mass * r * r
        i_trans = mass * (0.5 * r * r + L * L / 12.0)
        diag = {"x": (i_axial, i_trans, i_trans),
                "y": (i_trans, i_axial, i_trans),
                "z": (i_trans, i_trans, i_axial)}[axis]
        vol = math.pi * r * r * L
        return GeomMass(g.name, mass, vol, area, c, diag, axis)

    if g.type == "sphere":
        r = g.size[0]
        area = 4.0 * math.pi * r * r
        mass = area * wall * rho
        i = 2.0 / 3.0 * mass * r * r
        vol = 4.0 / 3.0 * math.pi * r ** 3
        return GeomMass(g.name, mass, vol, area, g.pos, (i, i, i), "z")

    if g.type == "ellipsoid":
        rx, ry, rz = g.size
        # Thomsen approximation of ellipsoid surface area
        p = 1.6075
        area = 4.0 * math.pi * (((rx * ry) ** p + (rx * rz) ** p + (ry * rz) ** p) / 3.0) ** (1.0 / p)
        mass = area * wall * rho
        # solid-ellipsoid inertia with the shell mass (small parts; close enough)
        ix = mass / 5.0 * (ry * ry + rz * rz)
        iy = mass / 5.0 * (rx * rx + rz * rz)
        iz = mass / 5.0 * (rx * rx + ry * ry)
        vol = 4.0 / 3.0 * math.pi * rx * ry * rz
        return GeomMass(g.name, mass, vol, area, g.pos, (ix, iy, iz), "z")

    if g.type == "box":
        hx, hy, hz = g.size
        ex, ey, ez = 2 * hx, 2 * hy, 2 * hz
        if g.role == "sole":
            vol = ex * ey * ez
            mass = vol * rho
            area = 2.0 * (ex * ey + ey * ez + ex * ez)
        else:
            area = 2.0 * (ex * ey + ey * ez + ex * ez)
            mass = area * wall * rho
            vol = ex * ey * ez
        ix = mass / 12.0 * (ey * ey + ez * ez)
        iy = mass / 12.0 * (ex * ex + ez * ez)
        iz = mass / 12.0 * (ex * ex + ey * ey)
        return GeomMass(g.name, mass, vol, area, g.pos, (ix, iy, iz), "z")

    raise ValueError(f"unsupported geom type {g.type!r}")


# ---------------------------------------------------------------------------
# Per-body assembly
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BodyMass:
    name: str
    shell_mass_kg: float
    actuator_mass_kg: float
    total_mass_kg: float
    com: Vec3                          # in body frame
    principal_inertia: Vec3            # diaginertia for MuJoCo
    principal_quat: tuple[float, float, float, float]  # inertial frame orientation
    # full inertia tensor about the COM, expressed in the body frame, as
    # (ixx, iyy, izz, ixy, ixz, iyz) — this is what URDF <inertia> wants.
    inertia_com: tuple[float, float, float, float, float, float]
    geoms: tuple[GeomMass, ...]


def _rotation_to_quat(rot: np.ndarray) -> tuple[float, float, float, float]:
    """Convert a 3x3 rotation matrix (columns = principal axes) to (w,x,y,z)."""
    m = rot
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([w, x, y, z], dtype=float)
    q /= np.linalg.norm(q)
    if q[0] < 0:
        q = -q
    return (float(q[0]), float(q[1]), float(q[2]), float(q[3]))


def compute_body_mass(body: Body) -> BodyMass:
    geom_masses = tuple(_shell_geom_mass(g) for g in body.geoms)
    shell_mass = sum(gm.mass_kg for gm in geom_masses)
    act_mass = body.actuator_mass_kg
    total = shell_mass + act_mass

    if total <= 0.0:
        # massless connector node (no shell, no actuator) — give MuJoCo a tiny
        # positive mass so the body is well-formed.
        eps = 1e-4
        return BodyMass(body.name, 0.0, 0.0, eps, (0.0, 0.0, 0.0),
                        (1e-6, 1e-6, 1e-6), (1.0, 0.0, 0.0, 0.0),
                        (1e-6, 1e-6, 1e-6, 0.0, 0.0, 0.0), geom_masses)

    # centre of mass (actuator at body origin contributes mass at (0,0,0))
    com = np.zeros(3)
    for gm in geom_masses:
        com += gm.mass_kg * np.array(gm.centroid)
    com /= total  # actuator term is mass*0
    com_t: Vec3 = (float(com[0]), float(com[1]), float(com[2]))

    # full inertia tensor about COM
    inertia = np.zeros((3, 3))
    for gm in geom_masses:
        local = np.diag(gm.inertia_diag).astype(float)
        d = np.array(gm.centroid) - com
        inertia += local + gm.mass_kg * (float(d @ d) * np.eye(3) - np.outer(d, d))
    # actuator point mass at origin
    d_act = -com
    inertia += act_mass * (float(d_act @ d_act) * np.eye(3) - np.outer(d_act, d_act))

    inertia = 0.5 * (inertia + inertia.T)
    inertia_com = (float(inertia[0, 0]), float(inertia[1, 1]), float(inertia[2, 2]),
                   float(inertia[0, 1]), float(inertia[0, 2]), float(inertia[1, 2]))
    evals, evecs = np.linalg.eigh(inertia)
    evals = np.clip(evals, 1e-7, None)
    # enforce the triangle inequality MuJoCo requires on principal moments
    evals = _enforce_triangle(evals)
    if np.linalg.det(evecs) < 0:
        evecs[:, 0] = -evecs[:, 0]
    quat = _rotation_to_quat(evecs)

    return BodyMass(
        name=body.name,
        shell_mass_kg=shell_mass,
        actuator_mass_kg=act_mass,
        total_mass_kg=total,
        com=com_t,
        principal_inertia=(float(evals[0]), float(evals[1]), float(evals[2])),
        principal_quat=quat,
        inertia_com=inertia_com,
        geoms=geom_masses,
    )


def _enforce_triangle(evals: np.ndarray) -> np.ndarray:
    a, b, c = sorted(evals)
    if a + b < c:
        c = a + b - 1e-9
    out = np.array(sorted([a, b, c]))
    # map back to original order by sorting input indices
    order = np.argsort(evals)
    result = np.empty(3)
    result[order] = out
    return result


# ---------------------------------------------------------------------------
# Whole-robot budget
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MassBudget:
    bodies: tuple[BodyMass, ...]
    total_mass_kg: float
    shell_mass_kg: float
    actuator_mass_kg: float
    mass_by_material: dict[str, float]
    mass_by_group: dict[str, float]


# Off-board / lumped masses not represented as structural shells. These are
# carried in the pelvis/torso in the MJCF (added as extra point mass) and the
# BOM. Values track the confirmed off-the-shelf selections.
ELECTRONICS_KG: dict[str, float] = {
    "battery_li_ion_custom_400wh": 2.2,
    "jetson_orin_nano": 0.18,
    "power_distribution_wiring": 0.9,
    "imu_bmi088": 0.01,
    "head_camera_d435i": 0.072,
}
ELECTRONICS_KG_TOTAL: float = sum(ELECTRONICS_KG.values())


def compute_budget(spec: RobotSpec | None = None) -> MassBudget:
    spec = spec or build_spec()
    body_masses = tuple(compute_body_mass(b) for b in spec.bodies)

    shell = sum(bm.shell_mass_kg for bm in body_masses)
    act = sum(bm.actuator_mass_kg for bm in body_masses)
    electronics = sum(ELECTRONICS_KG.values())

    by_mat: dict[str, float] = {}
    for bm in body_masses:
        for gm in bm.geoms:
            g = next(g for g in spec.body(bm.name).geoms if g.name == gm.name)
            by_mat[g.material_key] = by_mat.get(g.material_key, 0.0) + gm.mass_kg
    by_mat["OFF_THE_SHELF_ACTUATOR"] = act
    by_mat["ELECTRONICS"] = electronics

    by_group: dict[str, float] = {}
    for bm, b in zip(body_masses, spec.bodies, strict=True):
        by_group[b.group] = by_group.get(b.group, 0.0) + bm.total_mass_kg
    by_group["ELECTRONICS"] = electronics

    total = shell + act + electronics
    return MassBudget(
        bodies=body_masses,
        total_mass_kg=total,
        shell_mass_kg=shell,
        actuator_mass_kg=act,
        mass_by_material=by_mat,
        mass_by_group=by_group,
    )


if __name__ == "__main__":
    budget = compute_budget()
    print(f"erobot mass budget — total {budget.total_mass_kg:.2f} kg")
    print(f"  shells:      {budget.shell_mass_kg:6.2f} kg")
    print(f"  actuators:   {budget.actuator_mass_kg:6.2f} kg")
    print(f"  electronics: {sum(ELECTRONICS_KG.values()):6.2f} kg")
    print("  by material:")
    for k, v in sorted(budget.mass_by_material.items(), key=lambda kv: -kv[1]):
        print(f"    {k:28s} {v:6.2f} kg")
    print("  by group:")
    for k, v in sorted(budget.mass_by_group.items(), key=lambda kv: -kv[1]):
        print(f"    {k:12s} {v:6.2f} kg")
    print("  heaviest bodies:")
    for bm in sorted(budget.bodies, key=lambda b: -b.total_mass_kg)[:8]:
        print(f"    {bm.name:22s} {bm.total_mass_kg:5.2f} kg "
              f"(shell {bm.shell_mass_kg:.2f} + act {bm.actuator_mass_kg:.2f})  "
              f"I={tuple(round(x,4) for x in bm.principal_inertia)}")
