"""
Parametric CAD (B-rep) fembot parts -- NO mesh warping/smoothing.

Each part is a clean solid built with the OpenCascade kernel (cadquery): a B-spline
surface lofted through CLEAN elliptical cross-sections along the part's spine. Clean
ellipses + a strongly-smoothed axial taper give straight lines and smooth curves by
construction (no organic waviness, no pitting, round stays round). Feet get a flat
sole via a planar boolean cut.

Exports a STEP solid (the real CAD source) and a tessellated STL (for MuJoCo +
rendering) per link.

Run:  .venv/bin/python cad/asimov-feminine/param/cad_parts.py
"""
from __future__ import annotations

import os
import sys
import time

import cadquery as cq
import numpy as np
import trimesh
from scipy.ndimage import gaussian_filter1d

sys.path.insert(0, os.path.dirname(__file__))
import connections as C  # noqa: E402

ROBOT = "/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot"
SRC = os.path.join(ROBOT, "assets/profiles/asimov-1/meshes")
OUT = os.path.join(ROBOT, "cad/asimov-feminine/output/stl")
STEP = os.path.join(ROBOT, "cad/asimov-feminine/output/step")
AXIS_IDX = {"x": 0, "y": 1, "z": 2}

# per-part slim (cross-section scale); 1.0 = original width
SLIM = {
    "NECK_YAW": 0.86, "NECK_PITCH": 0.95,
    "LEFT_SHOULDER_PITCH": 0.92, "LEFT_SHOULDER_ROLL": 0.82, "LEFT_SHOULDER_YAW": 0.82,
    "LEFT_ELBOW": 0.82, "LEFT_WRIST_YAW": 0.85,
    "LEFT_HIP_PITCH": 0.92, "LEFT_HIP_ROLL": 0.92, "LEFT_HIP_YAW": 0.85,
    "LEFT_KNEE": 0.85, "LEFT_ANKLE_A": 0.9, "LEFT_ANKLE_B": 0.92, "LEFT_TOE": 0.95,
    "WAIST_YAW": 1.0, "IMU_ORIGIN": 0.96,
}
for _k in list(SLIM):
    if _k.startswith("LEFT_"):
        SLIM[_k.replace("LEFT_", "RIGHT_")] = SLIM[_k]


def _ellipse_sections(mesh, ai, dz=0.006, axial_smooth=6):
    """Smoothed elliptical cross-sections (centre + semi-axes) along spine axis ai."""
    pd = [i for i in range(3) if i != ai]
    lo, hi = mesh.bounds[0][ai], mesh.bounds[1][ai]
    levels = np.arange(lo + dz, hi - dz, dz)
    normal = np.zeros(3); normal[ai] = 1.0
    A, B, C0, C1, L = [], [], [], [], []
    for t in levels:
        o = np.zeros(3); o[ai] = t
        s = mesh.section(plane_origin=o, plane_normal=normal)
        if s is None:
            continue
        pts = np.vstack([np.asarray(e)[:, pd] for e in s.discrete])
        c = (pts.max(0) + pts.min(0)) / 2
        ext = (pts.max(0) - pts.min(0)) / 2
        A.append(ext[0]); B.append(ext[1]); C0.append(c[0]); C1.append(c[1]); L.append(t)
    if len(L) < 3:
        return None
    A = np.array(A); B = np.array(B); C0 = np.array(C0); C1 = np.array(C1); L = np.array(L)
    A = gaussian_filter1d(A, axial_smooth, mode="nearest")
    B = gaussian_filter1d(B, axial_smooth, mode="nearest")
    C0 = gaussian_filter1d(C0, axial_smooth, mode="nearest")
    C1 = gaussian_filter1d(C1, axial_smooth, mode="nearest")
    return L, C0, C1, A, B


def _loft(L, C0, C1, A, B, ai, slim, n=44):
    pd = [i for i in range(3) if i != ai]
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ct, st = np.cos(th), np.sin(th)
    wires = []
    for i in range(len(L)):
        P = np.zeros((n, 3))
        P[:, pd[0]] = C0[i] + A[i] * slim * ct
        P[:, pd[1]] = C1[i] + B[i] * slim * st
        P[:, ai] = L[i]
        edge = cq.Edge.makeSpline([cq.Vector(*p) for p in P], periodic=True)
        wires.append(cq.Wire.assembleEdges([edge]))
    return cq.Solid.makeLoft(wires, ruled=False)


def build_cad_part(link):
    mesh = trimesh.load(os.path.join(SRC, f"{link}.STL"), force="mesh")
    ai = AXIS_IDX[C.LINKS[link]["spine"]]
    sec = _ellipse_sections(mesh, ai)
    if sec is None:
        return None
    solid = _loft(*sec, ai, SLIM.get(link, 1.0))
    if link in ("LEFT_ANKLE_B", "RIGHT_ANKLE_B", "LEFT_TOE", "RIGHT_TOE"):
        z0 = mesh.bounds[0][2]
        box = cq.Solid.makeBox(1.0, 1.0, 1.0, cq.Vector(-0.5, -0.5, z0 + 0.006 - 1.0))
        solid = solid.cut(box)  # flat sole
    return solid


def _to_trimesh(solid, tol=0.0004):
    verts, faces = solid.tessellate(tol)
    return trimesh.Trimesh(np.array([[v.x, v.y, v.z] for v in verts]), np.array(faces), process=True)


def run():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True); os.makedirs(STEP, exist_ok=True)
    parts = sorted(set(SLIM) | {"WAIST_YAW", "IMU_ORIGIN"})
    print(f"{'PART':<22}{'vol_cm3':>9}{'faces':>8}{'wt':>6}")
    for link in parts:
        solid = build_cad_part(link)
        if solid is None:
            print(f"{link:<22} SKIP (too short)"); continue
        cq.exporters.export(cq.Workplane(obj=solid), os.path.join(STEP, f"{link}.step"))
        tm = _to_trimesh(solid)
        tm.export(os.path.join(OUT, f"{link}.STL"))
        print(f"{link:<22}{solid.Volume()*1e6:>9.0f}{len(tm.faces):>8}{str(tm.is_watertight):>6}")
    print(f"DONE in {time.time()-t0:.0f}s -> {OUT} (+ STEP in {STEP})")


if __name__ == "__main__":
    run()
