"""Watertight manifold mesh generation for every erobot part.

Bridges the parametric :class:`~eliza_robot.erobot.spec.Geom` (and the internal
components in :mod:`eliza_robot.erobot.components`) to real solid meshes via
trimesh's manifold-safe primitive constructors. No boolean ops are used, so
every mesh is watertight + winding-consistent by construction; the manifold
proof verifies that rather than assuming it.

Meshes are emitted in the *body-local* frame (the same frame the MJCF uses for
the body's geoms), so the ROM sweep can place them in world coordinates with the
body transforms MuJoCo reports.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh

from eliza_robot.erobot.spec import Geom

# Tessellation: coarse enough for fast FCL collision, fine enough to bound volume.
_SPHERE_SUBDIV = 3
_CYL_SECTIONS = 28


def _align_z_to(direction: np.ndarray) -> np.ndarray:
    direction = np.asarray(direction, dtype=float)
    n = np.linalg.norm(direction)
    if n < 1e-12:
        return np.eye(4)
    return trimesh.geometry.align_vectors([0.0, 0.0, 1.0], direction / n)


def _fromto_len_mid(fromto: tuple[float, ...]) -> tuple[float, np.ndarray, np.ndarray]:
    p0 = np.array(fromto[:3], dtype=float)
    p1 = np.array(fromto[3:], dtype=float)
    d = p1 - p0
    return float(np.linalg.norm(d)), (p0 + p1) / 2.0, d


def _ellipsoid(radii: tuple[float, float, float]) -> trimesh.Trimesh:
    m = trimesh.creation.icosphere(subdivisions=_SPHERE_SUBDIV, radius=1.0)
    m.apply_scale([max(r, 1e-5) for r in radii])
    return m


def primitive_mesh(geom: Geom) -> trimesh.Trimesh:
    """Solid manifold mesh for one structural shell geom, in the body frame.

    Shells are emitted as their *outer solid envelope*; wall hollowing is a
    manufacturing property carried by the mass model, not a separate mesh.
    """
    return _mesh(geom.type, geom.size, geom.fromto, geom.pos)


def _mesh(gtype: str, size: tuple[float, ...],
          fromto: tuple[float, ...] | None, pos: tuple[float, float, float]) -> trimesh.Trimesh:
    if gtype == "box":
        m = trimesh.creation.box(extents=[2 * size[0], 2 * size[1], 2 * size[2]])
        m.apply_translation(pos)
        return m
    if gtype == "sphere":
        m = trimesh.creation.icosphere(subdivisions=_SPHERE_SUBDIV, radius=size[0])
        m.apply_translation(pos)
        return m
    if gtype == "ellipsoid":
        m = _ellipsoid((size[0], size[1], size[2]))
        m.apply_translation(pos)
        return m
    if gtype in ("capsule", "cylinder"):
        assert fromto is not None
        length, mid, direction = _fromto_len_mid(fromto)
        if gtype == "capsule":
            m = trimesh.creation.capsule(height=length, radius=size[0], count=[12, _CYL_SECTIONS])
            # trimesh capsule spans [0, height] along z with caps; recenter to origin
            m.apply_translation([0, 0, -length / 2.0])
        else:
            m = trimesh.creation.cylinder(radius=size[0], height=length, sections=_CYL_SECTIONS)
        m.apply_transform(_align_z_to(direction))
        m.apply_translation(mid)
        return m
    if gtype == "annulus":
        # size = (r_inner, r_outer, height); axis along fromto (or z)
        m = trimesh.creation.annulus(r_min=size[0], r_max=size[1], height=size[2],
                                     sections=_CYL_SECTIONS)
        if fromto is not None:
            _, mid, direction = _fromto_len_mid(fromto)
            m.apply_transform(_align_z_to(direction))
            m.apply_translation(mid)
        else:
            m.apply_translation(pos)
        return m
    if gtype == "torus":
        # size = (major_radius, minor_radius)
        m = trimesh.creation.torus(major_radius=size[0], minor_radius=size[1],
                                   major_sections=_CYL_SECTIONS, minor_sections=12)
        if fromto is not None:
            _, mid, direction = _fromto_len_mid(fromto)
            m.apply_transform(_align_z_to(direction))
            m.apply_translation(mid)
        else:
            m.apply_translation(pos)
        return m
    raise ValueError(f"unsupported mesh type {gtype!r}")


def component_mesh(gtype: str, size: tuple[float, ...], pose: dict[str, Any]) -> trimesh.Trimesh:
    """Mesh for an internal component given a pose dict {pos, fromto}."""
    return _mesh(gtype, size, pose.get("fromto"), pose.get("pos", (0.0, 0.0, 0.0)))


def cavity_mesh(geom: Geom, wall_m: float) -> trimesh.Trimesh | None:
    """Inner cavity available for internal components: the shell offset inward by
    the wall thickness. Returns None for non-shell roles (solid soles)."""
    if geom.role != "shell":
        return None
    w = wall_m
    if geom.type == "box":
        inner = tuple(max(s - w, 1e-4) for s in geom.size)
        return _mesh("box", inner, None, geom.pos)
    if geom.type == "sphere":
        return _mesh("sphere", (max(geom.size[0] - w, 1e-4),), None, geom.pos)
    if geom.type == "ellipsoid":
        return _mesh("ellipsoid", tuple(max(s - w, 1e-4) for s in geom.size), None, geom.pos)
    if geom.type in ("capsule", "cylinder"):
        return _mesh(geom.type, (max(geom.size[0] - w, 1e-4),), geom.fromto, geom.pos)
    return None


@dataclass(frozen=True)
class ManifoldReport:
    name: str
    watertight: bool
    winding_consistent: bool
    euler_number: int
    n_vertices: int
    n_faces: int
    volume_m3: float
    area_m2: float
    is_convex: bool
    bounds_m: list[list[float]]

    @property
    def genus(self) -> int:
        # closed orientable surface: euler = 2 - 2*genus
        return (2 - self.euler_number) // 2

    @property
    def manifold_ok(self) -> bool:
        # A valid solid: closed (watertight), orientable with every edge shared by
        # exactly two faces (winding_consistent), positive volume, and an even
        # Euler number (2 for shells, 0 for ring/tube bearings — both manifold).
        return bool(self.watertight and self.winding_consistent
                    and self.volume_m3 > 0.0 and self.euler_number % 2 == 0)


def frustum_mesh(fromto: tuple[float, ...], r0: float, r1: float,
                 sections: int = 40) -> trimesh.Trimesh:
    """Tapered tube from end0 (radius r0) to end1 (radius r1) along `fromto`."""
    length, mid, direction = _fromto_len_mid(fromto)
    m = trimesh.creation.cylinder(radius=1.0, height=length, sections=sections)
    z = m.vertices[:, 2]
    t = (z + length / 2.0) / length          # 0 at -z end, 1 at +z end
    radial = r0 * (1.0 - t) + r1 * t
    m.vertices[:, 0] *= radial
    m.vertices[:, 1] *= radial
    m.apply_transform(_align_z_to(direction))
    m.apply_translation(mid)
    return m


# Bodies whose limb shell should taper (proximal radius -> distal radius factor).
_LIMB_TAPER = {
    "thigh": (1.18, 0.82), "shank": (1.12, 0.72), "upper_arm": (1.15, 0.8),
    "forearm": (1.12, 0.72),
}


def visual_mesh_for(geom: Geom) -> trimesh.Trimesh:
    """A render-quality mesh for one shell geom: limbs taper, spheres/ellipsoids
    are smoothed high-res, everything else falls back to the primitive."""
    base = geom.name.replace("left_", "").replace("right_", "")
    if geom.type == "capsule" and geom.fromto is not None:
        for key, (f0, f1) in _LIMB_TAPER.items():
            if key in base:
                r = geom.size[0]
                limb = frustum_mesh(geom.fromto, r * f0, r * f1)
                # rounded distal cap
                cap = trimesh.creation.icosphere(subdivisions=2, radius=r * f1)
                cap.apply_translation(geom.fromto[3:])
                return trimesh.util.concatenate([limb, cap])
    if geom.type in ("sphere", "ellipsoid"):
        if geom.type == "sphere":
            m = trimesh.creation.icosphere(subdivisions=4, radius=geom.size[0])
        else:
            m = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
            m.apply_scale(geom.size)
        m.apply_translation(geom.pos)
        return m
    if geom.type == "box" and geom.role == "shell":
        # rounded box: subdivide + volume-preserving Taubin smoothing
        m = trimesh.creation.box(extents=[2 * s for s in geom.size])
        for _ in range(2):
            m = m.subdivide()
        trimesh.smoothing.filter_taubin(m, iterations=12)
        m.apply_translation(geom.pos)
        return m
    return primitive_mesh(geom)


def export_visual_meshes(spec, mesh_dir) -> dict[str, str]:
    """Write a render mesh per shell geom (body-frame) as OBJ; return name->file."""
    from pathlib import Path

    mesh_dir = Path(mesh_dir)
    mesh_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[str, str] = {}
    for body in spec.bodies:
        for g in body.geoms:
            mesh = visual_mesh_for(g)
            fn = f"{g.name}.obj"
            mesh.export(mesh_dir / fn)
            mapping[g.name] = fn
    return mapping


def manifold_report(name: str, mesh: trimesh.Trimesh) -> ManifoldReport:
    return ManifoldReport(
        name=name,
        watertight=bool(mesh.is_watertight),
        winding_consistent=bool(mesh.is_winding_consistent),
        euler_number=int(mesh.euler_number),
        n_vertices=int(len(mesh.vertices)),
        n_faces=int(len(mesh.faces)),
        volume_m3=float(mesh.volume),
        area_m2=float(mesh.area),
        is_convex=bool(mesh.is_convex),
        bounds_m=[[round(float(x), 5) for x in row] for row in mesh.bounds],
    )


if __name__ == "__main__":
    from eliza_robot.erobot.spec import build_spec

    spec = build_spec()
    bad = 0
    total = 0
    for body in spec.bodies:
        for g in body.geoms:
            total += 1
            rep = manifold_report(g.name, primitive_mesh(g))
            ok = rep.manifold_ok
            bad += not ok
            tag = "ok " if ok else "BAD"
            print(f"  [{tag}] {g.name:22s} V={rep.volume_m3*1e6:8.1f} cm3  "
                  f"euler={rep.euler_number} wt={rep.watertight} wind={rep.winding_consistent}")
    print(f"{total} shell meshes, {bad} non-manifold")
