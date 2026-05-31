"""
Parametric CAD (B-rep) fembot parts from the constraint-driven source-fitted
control rings -- NO mesh warping/smoothing.

Each link's `source_fitted_parts/<link>.source-fitted-loft.json` holds the
constraint-driven control rings (cross-section profiles with the reserved joint
interfaces preserved). This lofts those real profiles into a clean OpenCascade
B-rep SOLID (cadquery): angle-align the rings so they don't twist, apply the
feminine slim (radial scale, held full at the joint levels so neighbours mate),
loft a B-spline surface, export STEP (CAD source) + tessellated STL.

Run:  .venv/bin/python cad/asimov-feminine/param/cad_parts.py
"""
from __future__ import annotations

import json
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
RINGS = os.path.join(ROBOT, "cad/asimov-feminine/param/source_fitted_parts")
OUT = os.path.join(ROBOT, "cad/asimov-feminine/output/stl")
STEP = os.path.join(ROBOT, "cad/asimov-feminine/output/step")
AXIS_IDX = {"x": 0, "y": 1, "z": 2}

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


def _aligned_profiles(link, n=48, axial_smooth=3):
    """Angle-aligned per-section radius profiles from the control rings."""
    path = os.path.join(RINGS, f"{link.lower()}.source-fitted-loft.json")
    d = json.load(open(path))
    rings = np.asarray(d["control_rings"], float)
    ai = AXIS_IDX[d["control_axis"]]
    pd = [i for i in range(3) if i != ai]
    bins = np.linspace(0, 2 * np.pi, n, endpoint=False)
    R, C0, C1, L = [], [], [], []
    for r in rings:
        c = r[:, pd].mean(0)
        dd = r[:, pd] - c
        ang = (np.arctan2(dd[:, 1], dd[:, 0]) + 2 * np.pi) % (2 * np.pi)
        rad = np.hypot(dd[:, 0], dd[:, 1])
        o = np.argsort(ang)
        a = np.concatenate([ang[o] - 2 * np.pi, ang[o], ang[o] + 2 * np.pi])
        rr = np.concatenate([rad[o]] * 3)
        R.append(np.interp(bins, a, rr)); C0.append(c[0]); C1.append(c[1]); L.append(r[:, ai].mean())
    R = np.array(R); C0 = np.array(C0); C1 = np.array(C1); L = np.array(L)
    order = np.argsort(L)
    R, C0, C1, L = R[order], C0[order], C1[order], L[order]
    R = gaussian_filter1d(R, axial_smooth, axis=0, mode="nearest")
    C0 = gaussian_filter1d(C0, axial_smooth, mode="nearest")
    C1 = gaussian_filter1d(C1, axial_smooth, mode="nearest")
    return ai, pd, bins, L, C0, C1, R


def _collar(L, reserved, ramp=0.022):
    if not reserved:
        return np.ones_like(L)
    d = np.min(np.abs(L[:, None] - np.array(reserved)[None, :]), axis=1)
    w = np.clip(d / ramp, 0, 1)
    return w * w * (3 - 2 * w)


def build_cad_part(link):
    ai, pd, bins, L, C0, C1, R = _aligned_profiles(link)
    if len(L) < 3:
        return None
    slim = SLIM.get(link, 1.0)
    reserved = [0.0] + [pos[ai] for pos in C.LINKS[link]["children"].values()]
    f = 1.0 + (slim - 1.0) * _collar(L, reserved)   # full at joints, slim mid-shaft
    ct, st = np.cos(bins), np.sin(bins)
    wires = []
    for i in range(len(L)):
        P = np.zeros((len(bins), 3))
        P[:, pd[0]] = C0[i] + R[i] * f[i] * ct
        P[:, pd[1]] = C1[i] + R[i] * f[i] * st
        P[:, ai] = L[i]
        edge = cq.Edge.makeSpline([cq.Vector(*p) for p in P], periodic=True)
        wires.append(cq.Wire.assembleEdges([edge]))
    solid = cq.Solid.makeLoft(wires, ruled=False)
    if link in ("LEFT_ANKLE_B", "RIGHT_ANKLE_B", "LEFT_TOE", "RIGHT_TOE"):
        zmin = solid.BoundingBox().zmin
        solid = solid.cut(cq.Solid.makeBox(1.0, 1.0, 1.0, cq.Vector(-0.5, -0.5, zmin + 0.006 - 1.0)))
    return solid


def _to_trimesh(solid, tol=0.0005):
    v, fc = solid.tessellate(tol)
    return trimesh.Trimesh(np.array([[p.x, p.y, p.z] for p in v]), np.array(fc), process=True)


def run():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True); os.makedirs(STEP, exist_ok=True)
    parts = sorted(set(SLIM) | {"WAIST_YAW", "IMU_ORIGIN"})
    print(f"{'PART':<22}{'vol_cm3':>9}{'faces':>8}{'wt':>6}")
    for link in parts:
        try:
            solid = build_cad_part(link)
        except Exception as exc:
            print(f"{link:<22} FAIL {type(exc).__name__}: {str(exc)[:50]}"); continue
        if solid is None:
            print(f"{link:<22} SKIP"); continue
        cq.exporters.export(cq.Workplane(obj=solid), os.path.join(STEP, f"{link}.step"))
        tm = _to_trimesh(solid)
        tm.export(os.path.join(OUT, f"{link}.STL"))
        print(f"{link:<22}{solid.Volume()*1e6:>9.0f}{len(tm.faces):>8}{str(tm.is_watertight):>6}")
    print(f"DONE in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    run()
