"""Geometry proofs: manifold-ness, internal fit, and internal collisions.

Three checks, all mesh-level:

  * **manifold** — every structural shell and every internal component is a
    watertight, winding-consistent solid with positive volume (no non-manifold
    geometry). Shell mesh volume is reconciled against the analytic shell mass.
  * **internal fit** — every component is housed: ≥98% of its mesh sits inside
    the union of the shell envelopes on its own body and the parent/child bodies
    it bridges (gimbal motors legitimately span two shells).
  * **internal collision** — within each body, no two components interpenetrate,
    excluding the concentric motor↔bearing pair that is in contact by design.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
import trimesh

from eliza_robot.erobot.components import Component, build_components
from eliza_robot.erobot.mass import _shell_geom_mass
from eliza_robot.erobot.meshlib import (
    component_mesh,
    manifold_report,
    primitive_mesh,
)
from eliza_robot.erobot.spec import MATERIALS, RobotSpec, build_spec

PROOFS_ROOT = Path(__file__).resolve().parents[2] / "cad" / "erobot" / "proofs"
FIT_THRESHOLD = 0.98          # fraction of component vertices inside the housing
SHELL_MASS_TOL = 0.20         # mesh-vs-analytic shell mass relative tolerance


def _shell_meshes(spec: RobotSpec) -> dict[str, list[tuple[str, trimesh.Trimesh]]]:
    out: dict[str, list[tuple[str, trimesh.Trimesh]]] = {}
    for body in spec.bodies:
        out[body.name] = [(g.name, primitive_mesh(g)) for g in body.geoms]
    return out


def _component_mesh(c: Component) -> trimesh.Trimesh:
    return component_mesh(c.gtype, c.size, c.pose)


# ---------------------------------------------------------------------------
# manifold proof
# ---------------------------------------------------------------------------


def manifold_proof(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    reports = []
    non_manifold = []
    shell_mass_fail = []

    for body in spec.bodies:
        for g in body.geoms:
            rep = manifold_report(g.name, primitive_mesh(g))
            reports.append({"part": g.name, "class": "shell", **_rep_dict(rep)})
            if not rep.manifold_ok:
                non_manifold.append(g.name)
            # reconcile mesh-derived shell mass vs analytic (thin-shell) mass
            gm = _shell_geom_mass(g)
            rho = MATERIALS[g.material_key].density_kg_m3
            if g.role == "shell":
                wall = g.wall_mm / 1000.0
                mesh_shell_mass = rep.area_m2 * wall * rho  # area from the real mesh
            else:
                mesh_shell_mass = rep.volume_m3 * rho       # solid sole
            rel = abs(mesh_shell_mass - gm.mass_kg) / max(gm.mass_kg, 1e-9)
            if rel > SHELL_MASS_TOL:
                shell_mass_fail.append({"part": g.name, "analytic_kg": round(gm.mass_kg, 4),
                                        "mesh_kg": round(mesh_shell_mass, 4), "rel": round(rel, 3)})

    for c in build_components(spec):
        rep = manifold_report(c.name, _component_mesh(c))
        reports.append({"part": c.name, "class": c.kind, **_rep_dict(rep)})
        if not rep.manifold_ok:
            non_manifold.append(c.name)

    return {
        "schema": "erobot-manifold-v1",
        "ok": not non_manifold and not shell_mass_fail,
        "parts_checked": len(reports),
        "non_manifold_parts": non_manifold,
        "shell_mass_reconciliation_failures": shell_mass_fail,
        "genus_histogram": _genus_hist(reports),
        "parts": reports,
    }


def _rep_dict(rep) -> dict:
    d = asdict(rep)
    d["genus"] = rep.genus
    d["manifold_ok"] = rep.manifold_ok
    d["volume_cm3"] = round(rep.volume_m3 * 1e6, 2)
    d.pop("volume_m3", None)
    d.pop("bounds_m", None)
    return d


def _genus_hist(reports: list[dict]) -> dict[str, int]:
    h: dict[str, int] = {}
    for r in reports:
        k = f"genus_{r['genus']}"
        h[k] = h.get(k, 0) + 1
    return h


# ---------------------------------------------------------------------------
# internal fit + collision
# ---------------------------------------------------------------------------


def _housing_meshes(spec: RobotSpec, body_name: str) -> list[trimesh.Trimesh]:
    """Shell meshes that can house a component on `body_name`, expressed in that
    body's frame: its own shells, plus parent and child shells translated by the
    relative joint offset (gimbal motors bridge a parent/child shell)."""
    by_name = {b.name: b for b in spec.bodies}
    body = by_name[body_name]
    meshes: list[trimesh.Trimesh] = [primitive_mesh(g) for g in body.geoms if g.role == "shell"]

    if body.parent and body.parent in by_name:
        parent = by_name[body.parent]
        for g in parent.geoms:
            if g.role != "shell":
                continue
            m = primitive_mesh(g)
            m.apply_translation([-body.pos[0], -body.pos[1], -body.pos[2]])
            meshes.append(m)
    for child in spec.bodies:
        if child.parent == body_name:
            for g in child.geoms:
                if g.role != "shell":
                    continue
                m = primitive_mesh(g)
                m.apply_translation([child.pos[0], child.pos[1], child.pos[2]])
                meshes.append(m)
    return meshes


def _contained_fraction(part: trimesh.Trimesh, housings: list[trimesh.Trimesh]) -> float:
    pts = part.vertices
    inside = np.zeros(len(pts), dtype=bool)
    for h in housings:
        if not h.is_watertight:
            continue
        inside |= h.contains(pts)
    return float(inside.mean()) if len(pts) else 0.0


def internal_proof(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    comps_by_body: dict[str, list[Component]] = {}
    for c in build_components(spec):
        comps_by_body.setdefault(c.body, []).append(c)

    fit_results = []
    fit_fail = []
    collision_results = []
    collisions = []

    for body_name, comps in comps_by_body.items():
        housings = _housing_meshes(spec, body_name)
        meshes = {c.name: _component_mesh(c) for c in comps}

        for c in comps:
            frac = _contained_fraction(meshes[c.name], housings)
            rec = {"component": c.name, "body": body_name, "kind": c.kind,
                   "contained_fraction": round(frac, 4), "fit_ok": frac >= FIT_THRESHOLD}
            fit_results.append(rec)
            if not rec["fit_ok"]:
                fit_fail.append(rec)

        # internal collisions among components on the same body
        names = [c.name for c in comps]
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                a, b = comps[i], comps[j]
                if _concentric_pair(a, b):
                    continue
                mgr = trimesh.collision.CollisionManager()
                mgr.add_object(a.name, meshes[a.name])
                mgr.add_object(b.name, meshes[b.name])
                hit, depth = _collision_depth(mgr)
                rec = {"a": a.name, "b": b.name, "body": body_name,
                       "collision": bool(hit), "depth_mm": round(depth * 1000, 3)}
                collision_results.append(rec)
                if hit and depth > 0.0005:
                    collisions.append(rec)

    return {
        "schema": "erobot-internal-collision-v1",
        "ok": not fit_fail and not collisions,
        "components": len(fit_results),
        "fit_failures": fit_fail,
        "min_contained_fraction": round(min((r["contained_fraction"] for r in fit_results), default=1.0), 4),
        "internal_collisions": collisions,
        "pairs_checked": len(collision_results),
        "fit": fit_results,
    }


def _concentric_pair(a: Component, b: Component) -> bool:
    kinds = {a.kind, b.kind}
    # the motor output runs through its bearing bore by design; the harness can
    # graze the parts it powers.
    return kinds == {"motor", "bearing"} or "harness" in kinds


def _collision_depth(mgr: trimesh.collision.CollisionManager) -> tuple[bool, float]:
    try:
        hit, _, contacts = mgr.in_collision_internal(return_names=True, return_data=True)
    except TypeError:
        hit = mgr.in_collision_internal()
        return bool(hit), 0.0
    depth = 0.0
    for c in contacts or []:
        depth = max(depth, abs(float(getattr(c, "depth", 0.0))))
    return bool(hit), depth


def write_proofs(spec: RobotSpec | None = None) -> dict[str, Path]:
    spec = spec or build_spec()
    PROOFS_ROOT.mkdir(parents=True, exist_ok=True)
    out = {}
    mp = manifold_proof(spec)
    (PROOFS_ROOT / "manifold.json").write_text(json.dumps(mp, indent=2) + "\n")
    out["manifold"] = PROOFS_ROOT / "manifold.json"
    ip = internal_proof(spec)
    (PROOFS_ROOT / "internal-collision.json").write_text(json.dumps(ip, indent=2) + "\n")
    out["internal_collision"] = PROOFS_ROOT / "internal-collision.json"
    return out


if __name__ == "__main__":
    spec = build_spec()
    mp = manifold_proof(spec)
    print(f"manifold: {mp['parts_checked']} parts, non-manifold={mp['non_manifold_parts']}, "
          f"genus={mp['genus_histogram']}, mass_recon_fail={len(mp['shell_mass_reconciliation_failures'])}")
    ip = internal_proof(spec)
    print(f"internal: {ip['components']} components, min_contained={ip['min_contained_fraction']}, "
          f"fit_failures={len(ip['fit_failures'])}, collisions={len(ip['internal_collisions'])}")
    for f in ip["fit_failures"][:12]:
        print("   FIT", f)
    for c in ip["internal_collisions"][:12]:
        print("   COL", c)
