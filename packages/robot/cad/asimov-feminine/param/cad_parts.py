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
SRC = os.path.join(ROBOT, "assets/profiles/asimov-1/meshes")
OUT = os.path.join(ROBOT, "cad/asimov-feminine/output/stl")
STEP = os.path.join(ROBOT, "cad/asimov-feminine/output/step")
MJCF = os.path.join(ROBOT, "assets/profiles/asimov-1/mjcf/asimov_eliza.xml")
AXIS_IDX = {"x": 0, "y": 1, "z": 2}


def _parse_children():
    """parent-link -> [(child-link, joint-pos in parent frame, child spine axis)].
    Read straight from the canonical asimov tree so the bosses land on the exact
    joint each neighbour plugs into."""
    import xml.etree.ElementTree as ET
    root = ET.parse(MJCF).getroot()
    name2file = {m.get("name"): m.get("file") for m in root.iter("mesh")}
    out, stack = {}, [(root.find("worldbody"), None, None)]
    while stack:
        elem, par_link, _ = stack.pop()
        for b in elem.findall("body"):
            link = None
            for g in b.findall("geom"):
                if g.get("type") == "mesh" and g.get("mesh") in name2file:
                    link = name2file[g.get("mesh")][:-4]  # strip .STL
            pos = np.array([float(x) for x in (b.get("pos") or "0 0 0").split()])
            if par_link and link and link in C.LINKS:
                ax = AXIS_IDX[C.LINKS[link]["spine"]]
                out.setdefault(par_link, []).append((link, pos, ax))
            stack.append((b, link or par_link, None))
    return out


CHILDREN = _parse_children()

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


def _boss_radius(link, p, axis, band=0.013, pct=80):
    """Original part's footprint radius around joint point `p` (perp to `axis`),
    from the source mesh -- the size of the real mounting boss the slim loft
    flattened away."""
    me = trimesh.load(os.path.join(SRC, f"{link}.STL"), force="mesh")
    v = np.asarray(me.vertices, float)
    pd = [i for i in range(3) if i != axis]
    sel = np.abs(v[:, axis] - p[axis]) < band
    if sel.sum() < 8:
        sel = np.zeros(len(v), bool)
        sel[np.argsort(np.abs(v[:, axis] - p[axis]))[:200]] = True
    q = v[sel][:, pd] - np.array([p[pd[0]], p[pd[1]]])
    return float(np.percentile(np.hypot(q[:, 0], q[:, 1]), pct))


def _add_bosses(solid, link, inward=0.055, overlap=0.007):
    """Union a real mounting boss at every joint this part owns (its own origin +
    each child joint) so the slim body reaches each neighbour at full original
    size -- no free-floating parts."""
    jobs = [(link, np.zeros(3), AXIS_IDX[C.LINKS[link]["spine"]])]  # own proximal mate
    jobs += [(link, p, ax) for (_c, p, ax) in CHILDREN.get(link, [])]
    for src_link, p, ax in jobs:
        r = _boss_radius(src_link, p, ax)
        if r < 0.012:
            continue
        ctr = solid.Center()
        out = 1.0 if p[ax] >= (ctr.x, ctr.y, ctr.z)[ax] else -1.0
        u = np.zeros(3); u[ax] = out
        base = p - inward * u
        boss = cq.Solid.makeCylinder(
            r, inward + overlap, cq.Vector(*base), cq.Vector(*u))
        solid = solid.fuse(boss)
    return solid.clean()


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
    solid = _add_bosses(solid, link)
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
