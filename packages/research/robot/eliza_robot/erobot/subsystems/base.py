"""Shared framework for detailed mechanism subsystems.

A subsystem (foot, knee, hip, waist, shoulder) is a named set of real mechanical
parts plus the mates that join them and the DOFs they articulate. Each subsystem
is *proved* mathematically and geometrically:

  * **manifold** — every part is a watertight solid (via trimesh).
  * **mate consistency** — every mate is dimensionally valid: a shaft fits its
    bore with the declared fit (clearance/interference) within tolerance, a bolt
    fits its hole, referenced parts exist, revolute mates name an axis.
  * **rotation** — for each DOF, the moving parts are rotated through the full
    range about the pivot and checked (FCL) for collision against the fixed
    parts; we report the collision-free fraction and the minimum clearance.

Subsystem modules build a :class:`Subsystem` and expose ``build()`` + ``proof()``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import trimesh

from eliza_robot.erobot.meshlib import component_mesh, manifold_report

Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class MechPart:
    """One physical part in the subsystem frame."""

    name: str
    kind: str            # structural|shaft|bearing|bushing|fastener|circlip|washer|hardstop|actuator|pulley|cable|spacer|gear
    mesh_type: str       # box|cylinder|sphere|ellipsoid|annulus|torus|capsule
    size: tuple[float, ...]
    pose: dict           # {"pos": (x,y,z)} and/or {"fromto": (...)}
    material: str = "PA6_GF30"
    moves_with: str | None = None   # DOF name this part rotates with; None = fixed/proximal
    qty: int = 1
    note: str = ""

    def mesh(self) -> trimesh.Trimesh:
        return component_mesh(self.mesh_type, self.size, self.pose)


@dataclass(frozen=True)
class Mate:
    """A joint between two parts with a verifiable dimensional fit."""

    a: str
    b: str
    kind: str            # revolute|fixed|bearing_fit|press_fit|running_fit|bolted|keyed|hardstop|cable
    axis: Vec3 | None = None
    fit: dict = field(default_factory=dict)   # e.g. {"shaft_dia":0.012,"bore_dia":0.0122}
    note: str = ""


@dataclass(frozen=True)
class DOF:
    name: str
    axis: Vec3
    origin: Vec3
    lower_rad: float
    upper_rad: float
    moving_parts: tuple[str, ...]    # parts distal to the pivot (rotate with this DOF)


@dataclass(frozen=True)
class Subsystem:
    name: str
    parts: tuple[MechPart, ...]
    mates: tuple[Mate, ...]
    dofs: tuple[DOF, ...]
    note: str = ""

    def part(self, name: str) -> MechPart:
        for p in self.parts:
            if p.name == name:
                return p
        raise KeyError(name)


# --- fit tolerances (m) ---
_CLEARANCE_FIT = (5e-6, 2e-4)      # bore - shaft, running/clearance fit
_PRESS_FIT = (-2e-4, -2e-6)        # bore - shaft, interference (negative)


def _check_mate(sub: Subsystem, m: Mate) -> dict:
    names = {p.name for p in sub.parts}
    issues: list[str] = []
    if m.a not in names:
        issues.append(f"unknown part {m.a!r}")
    if m.b not in names:
        issues.append(f"unknown part {m.b!r}")
    clearance_mm = None
    if m.kind in ("bearing_fit", "press_fit", "running_fit"):
        shaft = m.fit.get("shaft_dia")
        bore = m.fit.get("bore_dia")
        if shaft is None or bore is None:
            issues.append("fit needs shaft_dia + bore_dia")
        else:
            clr = bore - shaft
            clearance_mm = round(clr * 1000, 4)
            lo, hi = _PRESS_FIT if m.kind == "press_fit" else _CLEARANCE_FIT
            if not (lo <= clr <= hi):
                issues.append(f"{m.kind} clearance {clr*1000:.3f} mm out of [{lo*1000:.3f},{hi*1000:.3f}]")
    elif m.kind == "bolted":
        bolt = m.fit.get("bolt_dia")
        hole = m.fit.get("hole_dia")
        if bolt is None or hole is None:
            issues.append("bolted needs bolt_dia + hole_dia")
        elif bolt > hole:
            issues.append(f"bolt {bolt*1000:.2f} > hole {hole*1000:.2f} mm")
        else:
            clearance_mm = round((hole - bolt) * 1000, 4)
    elif m.kind in ("revolute", "hardstop") and m.axis is None:
        issues.append(f"{m.kind} mate needs an axis")
    return {"a": m.a, "b": m.b, "kind": m.kind, "clearance_mm": clearance_mm,
            "ok": not issues, "issues": issues}


def _rotate(mesh: trimesh.Trimesh, axis: Vec3, origin: Vec3, angle: float) -> trimesh.Trimesh:
    R = trimesh.transformations.rotation_matrix(angle, axis, origin)
    m = mesh.copy()
    m.apply_transform(R)
    return m


def _rotation_clearance(sub: Subsystem, dof: DOF, samples: int) -> dict:
    moving = [p for p in sub.parts if p.name in dof.moving_parts]
    fixed = [p for p in sub.parts if p.name not in dof.moving_parts
             and p.kind not in ("cable",)]
    if not moving or not fixed:
        return {"dof": dof.name, "collision_free_fraction": 1.0,
                "min_clearance_mm": None, "samples": 0, "ok": True}

    fixed_mgr = trimesh.collision.CollisionManager()
    for p in fixed:
        fixed_mgr.add_object(p.name, p.mesh())
    moving_meshes = {p.name: p.mesh() for p in moving}

    free = 0
    min_clear = float("inf")
    for frac in np.linspace(0.0, 1.0, samples):
        ang = dof.lower_rad + frac * (dof.upper_rad - dof.lower_rad)
        mgr = trimesh.collision.CollisionManager()
        for name, mesh in moving_meshes.items():
            mgr.add_object(name, _rotate(mesh, dof.axis, dof.origin, ang))
        hit = mgr.in_collision_other(fixed_mgr)
        if not hit:
            free += 1
            try:
                d = mgr.min_distance_other(fixed_mgr)
                min_clear = min(min_clear, d * 1000.0)
            except Exception:
                pass
    return {
        "dof": dof.name, "samples": samples,
        "range_deg": [round(np.degrees(dof.lower_rad), 1), round(np.degrees(dof.upper_rad), 1)],
        "collision_free_fraction": round(free / samples, 3),
        "min_clearance_mm": round(min_clear, 3) if min_clear != float("inf") else None,
        "ok": free == samples,
    }


def prove_subsystem(sub: Subsystem, *, rotation_samples: int = 13) -> dict:
    # 1. manifold
    manifold = []
    non_manifold = []
    for p in sub.parts:
        rep = manifold_report(p.name, p.mesh())
        manifold.append({"part": p.name, "kind": p.kind, "manifold_ok": rep.manifold_ok,
                         "volume_cm3": round(rep.volume_m3 * 1e6, 2)})
        if not rep.manifold_ok:
            non_manifold.append(p.name)

    # 2. mate consistency
    mate_reports = [_check_mate(sub, m) for m in sub.mates]
    mate_fail = [r for r in mate_reports if not r["ok"]]

    # 3. rotation
    rot_reports = [_rotation_clearance(sub, d, rotation_samples) for d in sub.dofs]
    rot_fail = [r for r in rot_reports if not r["ok"]]

    return {
        "subsystem": sub.name,
        "ok": not non_manifold and not mate_fail and not rot_fail,
        "part_count": sum(p.qty for p in sub.parts),
        "unique_parts": len(sub.parts),
        "mate_count": len(sub.mates),
        "dof_count": len(sub.dofs),
        "manifold_ok": not non_manifold,
        "non_manifold_parts": non_manifold,
        "mate_consistency_ok": not mate_fail,
        "mate_failures": mate_fail,
        "rotation_ok": not rot_fail,
        "rotation": rot_reports,
        "parts": manifold,
        "mates": mate_reports,
        "note": sub.note,
    }
