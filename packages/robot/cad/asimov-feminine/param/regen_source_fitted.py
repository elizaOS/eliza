"""
Parametric fembot regeneration by constant-affine / profile vertex warps.

Every part is produced from a COMPACT PARAMETER SET (not by hand-editing
triangles and not by gluing on primitives). The inspectable parametric record
for each link lives in `source_fitted_parts/<link>.source-fitted-loft.json`
(control rings + adjustable parameters); this generator realises those
parameters on the real ASIMOV geometry with the roundness/flatness-safe warps in
`warp2.py`:

  * limbs  -> warp_affine: a CONSTANT cross-section scale about the joint axis.
    Maps planes->planes (flat plates stay flat) and equal-scaled circles->circles
    (bores stay round), and preserves length so joint spacing / rotation axes are
    unchanged. One factor per limb family => the thinning is EVEN along the whole
    limb (no fat keep-out bulges left behind).
  * torso  -> warp_profile: uniform waist cinch + a smooth FRONT (+X) bust sector
    + a gentle back-arch centreline shift, all blended to zero at the neck and
    both shoulder connection rings so the mates are untouched.
  * pelvis -> Y-narrowing ramped toward the waist-top mate, hip sockets preserved.

Run:  .venv/bin/python cad/asimov-feminine/param/regen_source_fitted.py
"""
from __future__ import annotations

import math
import os
import sys
import time

import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(__file__))
import connections as C  # noqa: E402
import warp2 as W  # noqa: E402

ROBOT = "/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot"
SRC = os.path.join(ROBOT, "assets/profiles/asimov-1/meshes")
OUT = os.path.join(ROBOT, "cad/asimov-feminine/output/stl")

AXIS_IDX = {"x": 0, "y": 1, "z": 2}

# ── Even feminine slimming (constant cross-section scale; 1.0 = unchanged) ────
# One factor per limb family so the limb reads as UNIFORMLY slim end-to-end.
ARM = 0.78    # whole arm chain (shoulder roll/yaw, elbow, wrist)
ARM_YOKE = 0.88   # shoulder pitch yoke keeps a little structure at the torso mount
LEG = 0.80    # thigh + calf shaft, upper thigh
LEG_JOINT = 0.88  # ankle column
FOOT = 0.94   # toe (keep sole footprint)
NECK = 0.84
HEAD = 0.93

SLIM = {
    "NECK_YAW": NECK, "NECK_PITCH": HEAD,
    "LEFT_SHOULDER_PITCH": ARM_YOKE,
    "LEFT_SHOULDER_ROLL": ARM, "LEFT_SHOULDER_YAW": ARM,
    "LEFT_ELBOW": ARM, "LEFT_WRIST_YAW": ARM,
    "LEFT_HIP_PITCH": 0.90, "LEFT_HIP_ROLL": 0.90, "LEFT_HIP_YAW": LEG,
    "LEFT_KNEE": LEG, "LEFT_ANKLE_A": LEG_JOINT, "LEFT_ANKLE_B": LEG_JOINT,
    "LEFT_TOE": FOOT,
}
for _k in list(SLIM.keys()):
    if _k.startswith("LEFT_"):
        SLIM[_k.replace("LEFT_", "RIGHT_")] = SLIM[_k]

# Torso (WAIST_YAW) chest/back shaping. z local frame (waist mate at 0, shoulders
# ~0.261, neck ~0.378). Robot front = +X; the round waist-actuator drums sit at
# the lateral ±Y sides with their axis along Y. So the ONLY feature-safe moves are:
#   * waist cinch  -> scale Y only (along the drum axis: circular XZ faces preserved)
#   * bust         -> push the +X FRONT sector outward in X only, narrow enough to
#                     stay clear of the ±Y drums (sector half-angle < 90deg)
#   * back relief  -> pull the -X BACK sector in slightly, same clearance
# Everything is blended to zero at the neck + both shoulder mates and at the pelvis
# mate, so nothing that mates is touched. No centroid shift (it would shear the
# Y-axis drums across their z-span).
TORSO = dict(
    cinch_y_min=0.82, cinch_z=0.135, cinch_sigma=0.075,   # waist width (Y)
    back_in=0.94, back_z=0.150, back_sigma=0.07, back_halfdeg=45.0,
    z_lo=0.02, z_hi=0.235,   # shaping confined between pelvis skirt and shoulders
)

# Two breast effectors: localized outward (+X) mounds at (+-Y0, Z0) with a 2-D
# Gaussian falloff, gated to the front face so the lateral +-Y drums are untouched.
# This gives two DISTINCT breasts instead of a single centre ridge.
BREAST = dict(
    amp=0.030,        # peak +X projection (m)
    y0=0.050,         # lateral offset of each mound centre (m)
    z0=0.190,         # height of the mounds (m)
    sigma_y=0.034, sigma_z=0.045,
    front_halfdeg=70.0,
)

# Surface features to erase by masked Laplacian smoothing (fills shallow
# engravings without touching the rest of the shell). Boxes in link-local m.
FEATURE_BOXES = dict(
    chest_M=dict(x=(0.02, 0.12), y=(-0.045, 0.045), z=(0.150, 0.205), iters=40),
    back_text=dict(x=(-0.12, -0.02), y=(-0.075, 0.075), z=(0.060, 0.170), iters=30),
)
# Handle: a grab-bar with a tunnel on the upper back; delete + cap to remove it.
HANDLE_BOX = dict(x=(-0.115, -0.060), y=(-0.075, 0.075), z=(0.185, 0.285))


def _slice_centroids(v, axis_z, lo, hi, step=0.005):
    levels = np.arange(lo, hi + step, step)
    cx = np.zeros_like(levels)
    cy = np.zeros_like(levels)
    for i, z in enumerate(levels):
        sel = np.abs(axis_z - z) < step
        if sel.sum() >= 3:
            cx[i] = v[sel, 0].mean()
            cy[i] = v[sel, 1].mean()
    return levels, cx, cy


def _vertex_neighbors(faces, n):
    nbr = [set() for _ in range(n)]
    for a, b, c in faces:
        nbr[a].update((b, c)); nbr[b].update((a, c)); nbr[c].update((a, b))
    return [np.fromiter(s, dtype=np.int64) for s in nbr]


def _smooth_region(mesh, mask, iters):
    """Laplacian (umbrella) smoothing of only the masked vertices; boundary of the
    region is held fixed, so a shallow engraving is filled while the surrounding
    panel keeps its shape."""
    nbr = _vertex_neighbors(mesh.faces, len(mesh.vertices))
    v = mesh.vertices.copy()
    idx = np.flatnonzero(mask)
    for _ in range(iters):
        nv = v.copy()
        for i in idx:
            ns = nbr[i]
            if len(ns):
                nv[i] = 0.6 * v[i] + 0.4 * v[ns].mean(0)
        v = nv
    mesh.vertices = v
    return mesh


def _erase_feature(mesh, box, iters):
    v = mesh.vertices
    m = ((v[:, 0] >= box["x"][0]) & (v[:, 0] <= box["x"][1])
         & (v[:, 1] >= box["y"][0]) & (v[:, 1] <= box["y"][1])
         & (v[:, 2] >= box["z"][0]) & (v[:, 2] <= box["z"][1]))
    if m.any():
        _smooth_region(mesh, m, iters)
    return mesh


def _remove_handle(mesh, box):
    """Delete faces inside the handle box (the grab-bar + its tunnel) and cap the
    resulting boundary loops so the back stays watertight."""
    v = mesh.vertices
    inb = ((v[:, 0] >= box["x"][0]) & (v[:, 0] <= box["x"][1])
           & (v[:, 1] >= box["y"][0]) & (v[:, 1] <= box["y"][1])
           & (v[:, 2] >= box["z"][0]) & (v[:, 2] <= box["z"][1]))
    fmask = inb[mesh.faces].any(axis=1)
    keep = mesh.faces[~fmask]
    out = trimesh.Trimesh(mesh.vertices.copy(), keep, process=True)
    out.remove_unreferenced_vertices()
    out.fill_holes()
    return out


def _torso_warp(mesh):
    reserved = C.reserved_levels("WAIST_YAW")
    P = TORSO
    B = BREAST
    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, 2]
    w = W.connection_weight(z, reserved, ramp=0.03)
    band = np.clip((z - P["z_lo"]) / 0.04, 0, 1) * np.clip((P["z_hi"] - z) / 0.04, 0, 1)
    w = w * band
    levels, cx, _ = _slice_centroids(v, z, mesh.bounds[0][2], mesh.bounds[1][2])
    cxz = np.interp(z, levels, cx)

    # 1) waist cinch in Y only (drum axis) -> circular faces preserved
    gy = 1.0 + (P["cinch_y_min"] - 1.0) * np.exp(-((z - P["cinch_z"]) ** 2) / (2 * P["cinch_sigma"] ** 2))
    v[:, 1] = v[:, 1] * (1.0 + (gy - 1.0) * w)

    dx = v[:, 0] - cxz
    ang = np.degrees(np.arctan2(v[:, 1], dx))

    # 2) breasts: two outward (+X) effector mounds, gated to the front face so the
    #    lateral drums (ang ~ +-90deg) are not touched.
    front = (np.abs(ang) <= B["front_halfdeg"]) & (dx > 0)
    bump = np.zeros(len(v))
    for sgn in (-1.0, +1.0):
        gy2 = np.exp(-((v[:, 1] - sgn * B["y0"]) ** 2) / (2 * B["sigma_y"] ** 2))
        gz2 = np.exp(-((z - B["z0"]) ** 2) / (2 * B["sigma_z"] ** 2))
        bump = np.maximum(bump, B["amp"] * gy2 * gz2)
    v[front, 0] += bump[front] * w[front]

    # 3) back relief: pull -X back sector in slightly
    gk = (P["back_in"] - 1.0) * np.exp(-((z - P["back_z"]) ** 2) / (2 * P["back_sigma"] ** 2))
    back = (np.abs(np.abs(ang) - 180.0) <= P["back_halfdeg"]) & (dx < 0)
    fallb = np.where(back, 0.5 * (1 + np.cos(np.pi * (180.0 - np.abs(ang)) / P["back_halfdeg"])), 0.0)
    pullb = 1.0 + gk * fallb * w
    v[back, 0] = cxz[back] + dx[back] * pullb[back]

    m.vertices = v
    # 4) erase surface features, then remove the back handle (delete + cap)
    for box in FEATURE_BOXES.values():
        _erase_feature(m, box, box["iters"])
    m = _remove_handle(m, HANDLE_BOX)
    return m


# Pelvis (IMU_ORIGIN): the hip sockets sit at the lateral +-Y extremes with their
# axis along Y, so a Y-only narrow is ALONG their axis (circular XZ faces stay
# round) -- the same trick as the torso drums. The waist bore (top) and a small
# Z-axis circular boss near the top would be egged by Y scaling, so all three
# reserved levels (waist mate, both hips, self origin) are locked with a ramp and
# the boss sits inside the waist-mate lock. Net effect: the mid/lower pelvis body
# narrows in width while every mating ring and round feature is preserved.
PELVIS = dict(narrow_y=0.88, ramp=0.022)


def _pelvis_warp(mesh):
    reserved = C.reserved_levels("IMU_ORIGIN")
    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, 2]
    w = W.connection_weight(z, reserved, ramp=PELVIS["ramp"])  # 0 at mates -> 1 free
    cy = float(v[:, 1].mean())
    fy = 1.0 + (PELVIS["narrow_y"] - 1.0) * w
    v[:, 1] = cy + (v[:, 1] - cy) * fy
    m.vertices = v
    return m


def _joint_centerline(link, spine_i):
    """In-plane joint points vs spine coordinate: self origin (0,0) at spine 0
    plus every child joint at its spine level. Scaling the cross-section about
    THIS line (not the fixed spine axis) keeps every joint point exactly in
    place, so laterally-offset child mounts (elbow->wrist, ankle->toe, hip yoke)
    do not drift when the part is slimmed."""
    pd = [d for d in range(3) if d != spine_i]
    pts = [(0.0, (0.0, 0.0))]
    for pos in C.LINKS[link]["children"].values():
        pts.append((pos[spine_i], (pos[pd[0]], pos[pd[1]])))
    pts.sort(key=lambda kv: kv[0])
    levels = np.array([p[0] for p in pts])
    c0 = np.array([p[1][0] for p in pts])
    c1 = np.array([p[1][1] for p in pts])
    if len(levels) == 1:  # only the self joint -> constant centre on the axis
        levels = np.array([-1.0, 1.0])
        c0 = np.array([0.0, 0.0])
        c1 = np.array([0.0, 0.0])
    return levels, c0, c1


def _limb_warp(mesh, link, factor):
    if factor == 1.0:
        return mesh.copy()
    spine_i = AXIS_IDX[C.LINKS[link]["spine"]]
    pd = [d for d in range(3) if d != spine_i]
    levels, c0, c1 = _joint_centerline(link, spine_i)
    m = mesh.copy()
    v = m.vertices.copy()
    t = v[:, spine_i]
    cen0 = np.interp(t, levels, c0)
    cen1 = np.interp(t, levels, c1)
    v[:, pd[0]] = cen0 + (v[:, pd[0]] - cen0) * factor
    v[:, pd[1]] = cen1 + (v[:, pd[1]] - cen1) * factor
    m.vertices = v
    return m


def build_part(link: str) -> trimesh.Trimesh:
    m = trimesh.load(os.path.join(SRC, f"{link}.STL"))
    if link == "WAIST_YAW":
        return _torso_warp(m)
    if link == "IMU_ORIGIN":
        return _pelvis_warp(m)
    return _limb_warp(m, link, SLIM.get(link, 1.0))


def run() -> None:
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    parts = sorted(set(SLIM) | {"WAIST_YAW", "IMU_ORIGIN"})
    print(f"{'PART':<22}{'slim':>6}{'wt':>6}{'Xmm':>7}{'Ymm':>7}{'Zmm':>7}{'flat_dev_mm':>12}")
    for link in parts:
        m = build_part(link)
        m.export(os.path.join(OUT, f"{link}.STL"))
        e = (m.bounds[1] - m.bounds[0]) * 1000
        # planarity of the largest facets (should be ~0 for affine-warped plates)
        dev = 0.0
        fa = m.facets_area
        if len(fa):
            for idx in np.argsort(fa)[::-1][:4]:
                vids = np.unique(m.faces[m.facets[idx]].ravel())
                pts = m.vertices[vids]
                cc = pts.mean(0)
                _, _, vt = np.linalg.svd(pts - cc)
                dev = max(dev, float(np.abs((pts - cc) @ vt[2]).max() * 1000))
        tag = SLIM.get(link, 1.0)
        print(f"{link:<22}{tag:>6.2f}{str(m.is_watertight):>6}{e[0]:>7.0f}{e[1]:>7.0f}{e[2]:>7.0f}{dev:>11.4f}")
    print(f"DONE in {time.time() - t0:.0f}s -> {OUT}")


if __name__ == "__main__":
    run()
