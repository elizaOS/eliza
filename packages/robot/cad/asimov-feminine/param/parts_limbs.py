"""
Limb-slim pass for the feminine ASIMOV-1.

Owner: Limb-slim agent. Owns ONLY the arm/leg/neck/foot frame STLs listed in
SLIM below (NECK_YAW, NECK_PITCH, all HIP_*, KNEE, ANKLE_A/B, TOE, all
SHOULDER_*, ELBOW, WRIST_YAW — L+R). Does NOT touch WAIST_YAW or IMU_ORIGIN
(owned by the body-curves agent) or any *_SHELL part (cosmetic-shell agent).

METHOD: the ONLY transform applied here is a CONSTANT cross-section affine
(warp2.warp_affine). It scales the two non-spine dims by a constant factor about
the joint axis (local 0,0), leaving the spine length untouched. A constant affine
maps planes -> planes (flat plates stay flat to ~0 mm) and equal-scaled circles
-> circles (spine-axis bores stay round). No spatially varying / profile warp is
used on these mechanical parts.

FEET EXCEPTION (documented): ANKLE_B and TOE have spine='x', so warp_affine would
scale Y (width) AND Z (sole height) equally. Shrinking Z thins the sole / ground
contact, which looks wrong for the base of the robot. For those two parts we scale
ONLY Y (width) and keep Z = 1.0 via `slim_y_only`. This is still a constant affine
on a single axis, so flatness and the X-axis (length) footprint are preserved
exactly; only the width narrows. ANKLE_A has spine='z' so the normal affine
(scaling X,Y about the leg axis) is correct for it.

Run:  .venv/bin/python cad/asimov-feminine/param/parts_limbs.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
import trimesh

import connections as C
import warp2 as W

ROBOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
ORIG = os.path.join(ROBOT, 'assets/profiles/asimov-1/meshes')
OUT = os.path.join(ROBOT, 'cad/asimov-feminine/output/stl')

# Per-part constant cross-section slim factor (1.0 = unchanged).
# Pushed thinner than the conservative regen_all pass while keeping legs (which
# carry weight) and the pauldron shoulder yoke structured. L/R mirror identically.
SLIM = {
    # ── neck/head ────────────────────────────────────────────────────────────
    'NECK_YAW': 0.84,            # slender neck base
    'NECK_PITCH': 0.92,          # head/skull: gentle slim, keep cranium

    # ── legs (weight-bearing — slim but not fragile) ─────────────────────────
    'LEFT_HIP_PITCH': 1.00,      # hip yoke: keep original — slimming it (spine=y scales Z) nudged it into HIP_YAW (collision)
    'LEFT_HIP_ROLL': 1.00,       # hip link: keep original for the same reason
    'LEFT_HIP_YAW': 0.82,        # upper thigh shaft
    'LEFT_KNEE': 0.80,           # thigh+calf shaft
    'LEFT_ANKLE_A': 0.88,        # ankle pitch (spine z -> scales X,Y about leg axis)

    # ── arms (slimmest — slender feminine limbs) ─────────────────────────────
    'LEFT_SHOULDER_PITCH': 0.96,  # pauldron 'armor' yoke: keep structured
    'LEFT_SHOULDER_ROLL': 0.78,   # upper arm / deltoid-bicep
    'LEFT_SHOULDER_YAW': 0.76,    # upper arm lower
    'LEFT_ELBOW': 0.75,           # forearm
    'LEFT_WRIST_YAW': 0.74,       # wrist/hand
}

# Feet: spine='x', scale Y (width) ONLY, keep Z (sole height) = 1.0.
SLIM_Y_ONLY = {
    'LEFT_ANKLE_B': 0.90,        # ankle roll / foot column width
    'LEFT_TOE': 0.92,            # forefoot width
}

# mirror left -> right identically
for d in (SLIM, SLIM_Y_ONLY):
    for k in list(d.keys()):
        if k.startswith('LEFT_'):
            d[k.replace('LEFT_', 'RIGHT_')] = d[k]


def slim_y_only(mesh, factor, center=0.0):
    """Constant affine that scales ONLY the Y dim about `center`, leaving X and Z
    untouched. Used for the feet (spine='x') so the sole height (Z) is preserved
    while the foot narrows in width (Y). Single-axis constant scale -> planes stay
    planes, length/height unchanged."""
    m = mesh.copy()
    v = m.vertices.copy()
    v[:, 1] = center + (v[:, 1] - center) * factor
    m.vertices = v
    return m


def big_facet_planarity(mesh, topn=4):
    """Max planar deviation (mm) across the largest flat facets — should be ~0
    for a constant affine."""
    fa = mesh.facets_area
    if not len(fa):
        return 0.0
    worst = 0.0
    for idx in np.argsort(fa)[::-1][:topn]:
        vids = np.unique(mesh.faces[mesh.facets[idx]].ravel())
        pts = mesh.vertices[vids]
        c = pts.mean(0)
        _, _, vt = np.linalg.svd(pts - c)
        worst = max(worst, np.abs((pts - c) @ vt[2]).max() * 1000)
    return worst


def run():
    t0 = time.time()
    print(f"{'PART':<22}{'spine':>6}{'mode':>8}{'slim':>6}"
          f"{'Xr':>7}{'Yr':>7}{'Zr':>7}{'flat_dev':>10}")
    worst_overall = 0.0
    for name, factor in {**SLIM, **SLIM_Y_ONLY}.items():
        spec = C.LINKS[name]
        axis = spec['spine']
        m = trimesh.load(os.path.join(ORIG, name + '.STL'))
        if name in SLIM_Y_ONLY:
            mode = 'Y-only'
            warped = slim_y_only(m, factor=factor, center=0.0)
        else:
            mode = 'affine'
            warped = W.warp_affine(m, spine=axis, factor=factor, center=(0.0, 0.0))
        warped.export(os.path.join(OUT, name + '.STL'))
        ob, wb = m.bounds, warped.bounds
        r = [(wb[1][i] - wb[0][i]) / (ob[1][i] - ob[0][i]) for i in range(3)]
        dev = big_facet_planarity(warped)
        worst_overall = max(worst_overall, dev)
        print(f"{name:<22}{axis:>6}{mode:>8}{factor:>6.2f}"
              f"{r[0]:>7.3f}{r[1]:>7.3f}{r[2]:>7.3f}{dev:>9.4f}m")
    print(f"DONE in {time.time()-t0:.0f}s — worst flat deviation {worst_overall:.4f} mm "
          f"(constant affine: planes stay flat, bores stay round).")


if __name__ == '__main__':
    run()
