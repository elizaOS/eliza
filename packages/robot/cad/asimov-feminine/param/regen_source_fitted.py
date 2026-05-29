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
    amp=0.027,        # peak +X projection (m) -- lower => rounder, less pointy
    y0=0.058,         # lateral offset of each mound centre (m)
    z0=0.232,         # height of the mounds (m) -- high on the chest
    sigma_y=0.050, sigma_z=0.082,   # broad domes -> smooth round breasts, not cones
    front_halfdeg=88.0,
    smooth_iter=14,   # light Taubin to round only the breast effector apex
)

# Features removed by delete-faces-in-box + cap (robust for engraved/separate
# components). Boxes in link-local metres.
#   chest_M    : recessed 'm' logo on the front chest panel
#   back_text  : lettering on the back access panel
#   handle     : grab-bar + tunnel on the upper back
REMOVE_BOXES = dict(
    chest_M=dict(x=(0.045, 0.12), y=(-0.040, 0.040), z=(0.150, 0.205)),
    back_text=dict(x=(-0.115, -0.055), y=(-0.045, 0.045), z=(0.120, 0.165)),
    handle=dict(x=(-0.115, -0.060), y=(-0.075, 0.075), z=(0.185, 0.285)),
)


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


def _outer_ring(points2d, centre, n_ang):
    """Outer radial envelope of a slice's points: max radius per angular bin about
    the centre, gaps filled circularly. Drops all interior detail (engravings,
    connectors, internal structure)."""
    d = points2d - centre
    ang = (np.arctan2(d[:, 1], d[:, 0]) + 2 * np.pi) % (2 * np.pi)
    rad = np.hypot(d[:, 0], d[:, 1])
    bins = np.linspace(0, 2 * np.pi, n_ang, endpoint=False)
    r = np.full(n_ang, np.nan)
    bi = np.clip((ang / (2 * np.pi) * n_ang).astype(int), 0, n_ang - 1)
    for k in range(n_ang):
        sel = bi == k
        if sel.any():
            r[k] = rad[sel].max()
    good = ~np.isnan(r)
    if not good.all():  # fill empty bins by circular interpolation
        ext = np.concatenate([bins[good] - 2 * np.pi, bins[good], bins[good] + 2 * np.pi])
        rg = np.concatenate([r[good]] * 3)
        r = np.interp(bins, ext, rg)
    return bins, r


def _smooth_field(R, C0, C1, harmonics, axial_sigma):
    """Turn a noisy stack of per-slice radius profiles into genuinely smooth
    surfaces with long flowing lines (not blurred noise):

      * angular: keep only the lowest `harmonics` Fourier modes of r(theta) per
        slice -> removes every high-frequency dimple/lump; the cross-section
        becomes a clean low-order curve.
      * axial: low-pass each angular component along the spine -> the radius and
        the centreline vary smoothly from slice to slice (long lines), no banding.
    """
    from scipy.ndimage import gaussian_filter1d
    F = np.fft.rfft(R, axis=1)
    F[:, harmonics + 1:] = 0.0
    R = np.fft.irfft(F, R.shape[1], axis=1)
    R = gaussian_filter1d(R, axial_sigma, axis=0, mode="nearest")
    C0 = gaussian_filter1d(C0, axial_sigma, mode="nearest")
    C1 = gaussian_filter1d(C1, axial_sigma, mode="nearest")
    return R, C0, C1


def _torso_skin(mesh, n_ang=96, dz=0.005):
    """Smooth watertight outer skin of the torso lofted from per-slice outer
    envelopes, with the waist cinch, two breast effectors and back relief sculpted
    into the rings. Removes the M, back text, handle and connector clutter by
    construction (only the outer boundary survives)."""
    zlo, zhi = mesh.bounds[0][2], mesh.bounds[1][2]
    levels = np.arange(zlo + dz * 0.5, zhi, dz)
    normal = np.array([0.0, 0.0, 1.0])
    rings_b, rings_r, cxs, cys, zs = [], [], [], [], []
    for z in levels:
        s = mesh.section(plane_origin=[0, 0, z], plane_normal=normal)
        if s is None:
            continue
        pts = np.vstack([np.asarray(e)[:, :2] for e in s.discrete])
        c = pts.mean(0)
        b, r = _outer_ring(pts, c, n_ang)
        rings_b.append(b); rings_r.append(r); cxs.append(c[0]); cys.append(c[1]); zs.append(z)
    zs = np.array(zs); cxs = np.array(cxs); cys = np.array(cys)
    R_arr = np.array(rings_r)            # (N, n_ang)
    bins = rings_b[0]
    # genuinely smooth base surface: low Fourier order + axial low-pass
    R_arr, cxs, cys = _smooth_field(R_arr, cxs, cys, harmonics=6, axial_sigma=4.0)

    P, B = TORSO, BREAST
    reserved = C.reserved_levels("WAIST_YAW")
    w = W.connection_weight(zs, reserved, ramp=0.03)
    band = np.clip((zs - P["z_lo"]) / 0.04, 0, 1) * np.clip((P["z_hi"] - zs) / 0.04, 0, 1)
    w = w * band
    cosb, sinb = np.cos(bins), np.sin(bins)

    verts = []
    for i, z in enumerate(zs):
        r = R_arr[i].copy()
        cx, cy = cxs[i], cys[i]
        x = cx + r * cosb
        y = cy + r * sinb
        # waist cinch in Y
        gy = 1.0 + (P["cinch_y_min"] - 1.0) * math.exp(-((z - P["cinch_z"]) ** 2) / (2 * P["cinch_sigma"] ** 2))
        y = cy + (y - cy) * (1.0 + (gy - 1.0) * w[i])
        # two breast effectors: outward +X mounds on the front face
        front = cosb > math.cos(math.radians(B["front_halfdeg"]))
        gz = math.exp(-((z - B["z0"]) ** 2) / (2 * B["sigma_z"] ** 2))
        bump = np.zeros(n_ang)
        for sgn in (-1.0, 1.0):
            bump = np.maximum(bump, B["amp"] * gz * np.exp(-((y - sgn * B["y0"]) ** 2) / (2 * B["sigma_y"] ** 2)))
        x = x + np.where(front, bump * w[i], 0.0)
        # back relief: pull the back (-X) in slightly
        back = cosb < -math.cos(math.radians(P["back_halfdeg"]))
        gk = (P["back_in"] - 1.0) * math.exp(-((z - P["back_z"]) ** 2) / (2 * P["back_sigma"] ** 2))
        x = np.where(back, cx + (x - cx) * (1.0 + gk * w[i]), x)
        verts.append(np.column_stack([x, y, np.full(n_ang, z)]))
    rings = np.array(verts)
    skin = _loft_rings(rings)
    # Taubin smoothing rounds the breast apex and any residual ribbing without the
    # net shrinkage of plain Laplacian (lambda/mu pair preserves volume).
    it = BREAST.get("smooth_iter", 0)
    if it:
        try:
            import pyvista as pv
            f = np.hstack([np.full((len(skin.faces), 1), 3), skin.faces]).ravel()
            sm = pv.PolyData(skin.vertices, f).smooth_taubin(n_iter=it, pass_band=0.1).triangulate()
            skin = trimesh.Trimesh(sm.points, sm.faces.reshape(-1, 4)[:, 1:], process=True)
        except Exception:
            trimesh.smoothing.filter_taubin(skin, iterations=it)
    return skin


def _skin_part(mesh, spine, n_ang=72, dz=0.004, taubin=8, flat_bottom=False,
               reserved=None, neck_depth=0.16, neck_sigma=0.015):
    """Smooth watertight outer skin for a limb/head: loft per-slice outer
    envelopes along the spine axis about the slice centroid. Produces a clean
    single-solid futuristic shell with no bolt-boss lumps or voxel terracing.

    `reserved` are the spine-axis joint levels; the radius is necked in toward
    each one (a smooth waist) so adjacent segments have the rotation clearance to
    bend without colliding — the smooth shaft alone would butt solid-to-solid."""
    ai = AXIS_IDX[spine]
    pd = [i for i in range(3) if i != ai]
    lo, hi = mesh.bounds[0][ai], mesh.bounds[1][ai]
    levels = np.arange(lo + dz * 0.5, hi, dz)
    normal = np.zeros(3); normal[ai] = 1.0
    Rs, C0, C1, L = [], [], [], []
    for t in levels:
        o = np.zeros(3); o[ai] = t
        s = mesh.section(plane_origin=o, plane_normal=normal)
        if s is None:
            continue
        pts = np.vstack([np.asarray(e)[:, pd] for e in s.discrete])
        c = pts.mean(0)
        b, r = _outer_ring(pts, c, n_ang)
        Rs.append(r); C0.append(c[0]); C1.append(c[1]); L.append(t)
    Rs = np.array(Rs); C0 = np.array(C0); C1 = np.array(C1); L = np.array(L)
    bins = b
    # Axial smoothing scaled to the part length: long parts get long smooth lines,
    # short connectors are barely smoothed so their joint ends are not shrunk away
    # (over-smoothing short parts was what opened the joint gaps).
    sig = float(np.clip(len(L) / 12.0, 1.0, 5.0))
    Rs, C0, C1 = _smooth_field(Rs, C0, C1, harmonics=5, axial_sigma=sig)
    # neck the radius in toward each joint level -> rotation clearance
    for lvl in (reserved or []):
        Rs = Rs * (1.0 - neck_depth * np.exp(-(((L - lvl) / neck_sigma) ** 2)))[:, None]
    cosb, sinb = np.cos(bins), np.sin(bins)
    verts = []
    for i, t in enumerate(L):
        p = np.zeros((n_ang, 3))
        p[:, pd[0]] = C0[i] + Rs[i] * cosb
        p[:, pd[1]] = C1[i] + Rs[i] * sinb
        p[:, ai] = t
        verts.append(p)
    skin = _loft_rings(np.array(verts))
    if taubin:
        import pyvista as pv
        f = np.hstack([np.full((len(skin.faces), 1), 3), skin.faces]).ravel()
        sm = pv.PolyData(skin.vertices, f).smooth_taubin(n_iter=taubin, pass_band=0.1).triangulate()
        skin = trimesh.Trimesh(sm.points, sm.faces.reshape(-1, 4)[:, 1:], process=True)
    if flat_bottom:  # feet: cleanly cut a flat sole (slice + cap), no ragged snap
        z0 = skin.vertices[:, 2].min()
        cut = trimesh.intersections.slice_mesh_plane(
            skin, plane_normal=[0, 0, 1], plane_origin=[0, 0, z0 + 0.006], cap=True
        )
        if cut is not None and len(cut.faces) > 0:
            cut.merge_vertices()
            skin = cut
    return skin


# Limbs/head get the smooth skin treatment. Feet (flat soles) and the pelvis keep
# the warp + watertight-cleanup path so their flat/socket features are preserved.
SKIN_LIMBS = {
    "NECK_YAW", "NECK_PITCH",
    "LEFT_SHOULDER_PITCH", "LEFT_SHOULDER_ROLL", "LEFT_SHOULDER_YAW",
    "LEFT_ELBOW", "LEFT_WRIST_YAW",
    "LEFT_HIP_PITCH", "LEFT_HIP_ROLL", "LEFT_HIP_YAW", "LEFT_KNEE", "LEFT_ANKLE_A",
}
for _k in list(SKIN_LIMBS):
    if _k.startswith("LEFT_"):
        SKIN_LIMBS.add(_k.replace("LEFT_", "RIGHT_"))

# Only these long swinging shafts get a gentle joint waist for bend clearance.
NECK_SHAFTS = {
    "LEFT_SHOULDER_ROLL", "LEFT_SHOULDER_YAW", "LEFT_ELBOW",
    "LEFT_HIP_YAW", "LEFT_KNEE", "LEFT_ANKLE_A",
}
for _k in list(NECK_SHAFTS):
    if _k.startswith("LEFT_"):
        NECK_SHAFTS.add(_k.replace("LEFT_", "RIGHT_"))


def _centerline_xy(V, ai, pd, nb=50):
    t = V[:, ai]
    e = np.linspace(t.min(), t.max(), nb + 1)
    mids = 0.5 * (e[:-1] + e[1:])
    cx = np.array([np.median(V[(t >= e[i]) & (t < e[i + 1]), pd[0]]) if ((t >= e[i]) & (t < e[i + 1])).any() else np.nan for i in range(nb)])
    cy = np.array([np.median(V[(t >= e[i]) & (t < e[i + 1]), pd[1]]) if ((t >= e[i]) & (t < e[i + 1])).any() else np.nan for i in range(nb)])
    for a in (cx, cy):
        g = ~np.isnan(a)
        a[~g] = np.interp(mids[~g], mids[g], a[g])
    return mids, cx, cy


def _smooth_tube(mesh, ai, pd, z_lo, z_hi, slim, n_ang=64, dz=0.004):
    """Clean smooth outer-envelope tube for a shaft interval, slimmed. Low Fourier
    order (no dimples) + axial low-pass (long lines)."""
    from scipy.ndimage import gaussian_filter1d
    normal = np.zeros(3); normal[ai] = 1.0
    bins = np.linspace(0, 2 * np.pi, n_ang, endpoint=False)
    R, C0, C1, L = [], [], [], []
    for t in np.arange(z_lo, z_hi + dz, dz):
        o = np.zeros(3); o[ai] = t
        s = mesh.section(plane_origin=o, plane_normal=normal)
        if s is None:
            continue
        pts = np.vstack([np.asarray(e)[:, pd] for e in s.discrete])
        c = pts.mean(0)
        b, r = _outer_ring(pts, c, n_ang)
        R.append(r); C0.append(c[0]); C1.append(c[1]); L.append(t)
    if len(L) < 2:
        return None
    R = np.array(R); C0 = np.array(C0); C1 = np.array(C1); L = np.array(L)
    F = np.fft.rfft(R, axis=1); F[:, 6:] = 0.0; R = np.fft.irfft(F, n_ang, axis=1)
    R = gaussian_filter1d(R, 3, axis=0, mode="nearest") * slim
    C0 = gaussian_filter1d(C0, 3, mode="nearest"); C1 = gaussian_filter1d(C1, 3, mode="nearest")
    cosb, sinb = np.cos(bins), np.sin(bins)
    verts = []
    for i in range(len(L)):
        p = np.zeros((n_ang, 3))
        p[:, pd[0]] = C0[i] + R[i] * cosb
        p[:, pd[1]] = C1[i] + R[i] * sinb
        p[:, ai] = L[i]
        verts.append(p)
    return _loft_rings(np.array(verts))


def _hybrid_part(mesh, link, slim, joint_margin=0.030):
    """Smooth slim mid-shaft + the ORIGINAL (slimmed) joint caps at each reserved
    level. The caps keep the real clevis/condyle so the limb articulates exactly
    like the source; the shaft is a clean feminine tube. Short connectors (reserved
    levels closer than 2*joint_margin) have no shaft and stay fully mechanical."""
    spine = C.LINKS[link]["spine"]
    ai = AXIS_IDX[spine]
    pd = [i for i in range(3) if i != ai]
    base = W.warp_affine(mesh, spine=spine, factor=slim, center=(0.0, 0.0))
    res = sorted(C.reserved_levels(link))
    z_lo, z_hi = res[0] + joint_margin, res[-1] - joint_margin
    if z_hi - z_lo < 0.02:
        return base  # too short for a shaft -> keep the real slimmed mechanism
    tube = _smooth_tube(base, ai, pd, z_lo - 0.006, z_hi + 0.006, slim)
    if tube is None:
        return base
    V = base.vertices
    t = V[:, ai]
    top = trimesh.Trimesh(V.copy(), base.faces[(t[base.faces] >= z_hi).all(1)], process=True)
    top.remove_unreferenced_vertices()
    bot = trimesh.Trimesh(V.copy(), base.faces[(t[base.faces] <= z_lo).all(1)], process=True)
    bot.remove_unreferenced_vertices()
    return trimesh.util.concatenate([top, tube, bot])


def _loft_rings(rings):
    n, p, _ = rings.shape
    verts = rings.reshape(-1, 3).tolist()
    faces = []
    for i in range(n - 1):
        a, b = i * p, (i + 1) * p
        for j in range(p):
            j2 = (j + 1) % p
            faces.append([a + j, a + j2, b + j2])
            faces.append([a + j, b + j2, b + j])
    c0 = len(verts); verts.append(rings[0].mean(0).tolist())
    for j in range(p):
        faces.append([c0, (j + 1) % p, j])
    base = (n - 1) * p
    c1 = len(verts); verts.append(rings[-1].mean(0).tolist())
    for j in range(p):
        faces.append([c1, base + j, base + (j + 1) % p])
    return trimesh.Trimesh(np.array(verts), np.array(faces), process=True)


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
    # 4) remove chest M, back text, and back handle (delete faces + cap)
    for box in REMOVE_BOXES.values():
        m = _delete_and_cap(m, box)
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
    # Constant cross-section scale (no joint collar): a full-width collar at the
    # joint makes neighbouring segments butt solid-to-solid and JAM on rotation.
    v[:, pd[0]] = cen0 + (v[:, pd[0]] - cen0) * factor
    v[:, pd[1]] = cen1 + (v[:, pd[1]] - cen1) * factor
    m.vertices = v
    return m


def _watertight_cleanup(mesh, pitch=0.0025, close=1, erode=1, sinc=18):
    """Rebuild a part as a single watertight, manifold solid: union the closed
    sub-components into an occupancy volume, fill interior holes, contour, and
    smooth out the voxel terracing. Used for the mechanical parts whose source
    meshes are messy multi-body unions (bolts/housings sharing edges)."""
    import vtk
    import pyvista as pv
    from scipy import ndimage

    b = mesh.bounds
    pad = pitch * (close + 4)
    origin = b[0] - pad
    dims = np.ceil((b[1] + pad - origin) / pitch).astype(int) + 1
    occ = np.zeros(tuple(dims), bool)
    for c in mesh.split(only_watertight=False):
        if len(c.faces) < 4:
            continue
        try:
            vg = c.voxelized(pitch).fill()
        except Exception:
            continue
        idx = np.round((vg.points - origin) / pitch).astype(int)
        ok = np.all((idx >= 0) & (idx < dims), axis=1)
        idx = idx[ok]
        occ[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    occ = ndimage.binary_closing(occ, iterations=close)
    occ = ndimage.binary_fill_holes(occ)
    if erode:
        occ = ndimage.binary_erosion(occ, iterations=erode)
    img = pv.ImageData(dimensions=tuple(dims), spacing=(pitch,) * 3, origin=tuple(origin))
    img.point_data["v"] = occ.astype(np.float32).ravel(order="F")
    surf = img.contour([0.5], scalars="v").triangulate()
    sm = vtk.vtkWindowedSincPolyDataFilter()
    sm.SetInputData(surf)
    sm.SetNumberOfIterations(sinc)
    sm.SetPassBand(0.1)
    sm.NonManifoldSmoothingOn()
    sm.NormalizeCoordinatesOn()
    sm.Update()
    surf = pv.wrap(sm.GetOutput()).triangulate()
    f = surf.faces.reshape(-1, 4)[:, 1:]
    out = trimesh.Trimesh(surf.points, f, process=True)
    cc = out.split(only_watertight=False)
    if len(cc) > 1:
        out = max(cc, key=lambda x: len(x.faces))
    return out


# Cosmetic ends that don't carry an articulating shaft -> smooth skin (head,
# neck collar, hands).
COSMETIC_SKIN = {"NECK_PITCH", "NECK_YAW", "LEFT_WRIST_YAW", "RIGHT_WRIST_YAW"}
FEET = {"LEFT_ANKLE_B", "RIGHT_ANKLE_B", "LEFT_TOE", "RIGHT_TOE"}


def _flat_sole(mesh):
    z0 = mesh.vertices[:, 2].min()
    cut = trimesh.intersections.slice_mesh_plane(
        mesh, plane_normal=[0, 0, 1], plane_origin=[0, 0, z0 + 0.006], cap=True
    )
    return cut if (cut is not None and len(cut.faces) > 0) else mesh


def build_part(link: str, cleanup: bool = True) -> trimesh.Trimesh:
    m = trimesh.load(os.path.join(SRC, f"{link}.STL"))
    slim = SLIM.get(link, 1.0)
    if link == "WAIST_YAW":
        return _torso_skin(m)  # smooth cosmetic torso (breasts, features removed)
    if link in COSMETIC_SKIN:
        return _skin_part(_limb_warp(m, link, slim), C.LINKS[link]["spine"])
    if link == "IMU_ORIGIN":
        return _pelvis_warp(m)  # keep real hip sockets (slimmed inward)
    if link in FEET:
        return _flat_sole(_limb_warp(m, link, slim))  # real foot, slimmed, flat sole
    # Mechanical limbs/connectors: smooth slim shaft + ORIGINAL slimmed joint caps.
    # Long shafts get a clean tube; short connectors stay fully mechanical.
    return _hybrid_part(m, link, slim)


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
