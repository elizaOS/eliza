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

# Torso (WAIST_YAW) chest/back shaping. z local frame: waist mate at 0, shoulders
# ~0.261, neck ~0.378. Front = +X.
def _torso_warp(mesh):
    reserved = C.reserved_levels("WAIST_YAW")

    def cinch(z):  # uniform waist cinch low, ribcage taper above
        waist = 0.86 + 0.14 * (1 - math.exp(-((z - 0.06) ** 2) / (2 * 0.05 ** 2)))
        rib = 0.94 if z > 0.18 else 1.0
        return min(waist, 1.0) * rib

    def bust_gain(z):  # +X front sector gain, localised at the bust band
        return 1.0 + 0.16 * math.exp(-((z - 0.215) ** 2) / (2 * 0.055 ** 2))

    def arch(z):  # gentle posture S: chest forward (+X) high, small -X mid
        fwd = 0.010 * math.exp(-((z - 0.27) ** 2) / (2 * 0.06 ** 2))
        return (fwd, 0.0)

    return W.warp_profile(
        mesh, axis="z", scale_fn=cinch,
        bulges=[{"center": 0.0, "width": math.radians(150), "gain": bust_gain}],
        shift_fn=arch, reserved=reserved, ramp=0.03,
    )


def _pelvis_warp(mesh):
    """Narrow the pelvis in Y toward the waist-top mate; keep hip sockets full."""
    reserved = C.reserved_levels("IMU_ORIGIN")
    waist_top = max(reserved)
    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, 2]
    cy = float(v[:, 1].mean())
    t = np.clip((z - mesh.bounds[0][2]) / max(waist_top - mesh.bounds[0][2], 1e-6), 0, 1)
    f = 1.0 + (0.90 - 1.0) * t  # 1.0 at hips -> 0.90 at waist top
    v[:, 1] = cy + (v[:, 1] - cy) * f
    m.vertices = v
    return m


def build_part(link: str) -> trimesh.Trimesh:
    m = trimesh.load(os.path.join(SRC, f"{link}.STL"))
    if link == "WAIST_YAW":
        return _torso_warp(m)
    if link == "IMU_ORIGIN":
        return _pelvis_warp(m)
    spine = C.LINKS[link]["spine"]
    return W.warp_affine(m, spine=spine, factor=SLIM.get(link, 1.0), center=(0.0, 0.0))


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
