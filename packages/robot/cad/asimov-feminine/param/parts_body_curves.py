"""
Feminine body curves for the cosmetic torso (WAIST_YAW) and pelvis (IMU_ORIGIN).

These are the TWO parts where curved cosmetic surfaces are explicitly accepted
(the user signed off on the torso/pelvis losing flat-plate character to gain a
feminine silhouette). We therefore use warp2.warp_profile (direct-vertex
directional warp) here and ONLY here. No limb STL is touched.

Design, in each part's LOCAL frame (+X = front, +Z = up):

WAIST_YAW (torso column, Z in [-0.004, 0.378]):
  reserved Z = [0.000 pelvis-mate, 0.261 both shoulders, 0.378 neck] -> all locked.
  * waist cinch  : uniform radial dip ~0.86 centred in the low waist band (z~0.10)
  * bust swell   : smooth FRONT (+X) sector push-out in the chest band, centred
                   BELOW the shoulder lock (z~0.205) so the swell grows out of the
                   chest and blends back to nothing before the shoulder ring. Wide
                   cosine sector + gaussian Z falloff => a swell, not a sphere.
  * ribcage taper: gentle uniform slim just under the bust (z~0.16) so the bust
                   reads as the widest front point.
  * back arch    : centroid shift toward -X (back) in the mid torso (~12 mm).

IMU_ORIGIN (pelvis, Z in [-0.104, 0.080]):
  reserved Z = [-0.044 both hips, 0.000 parent, 0.075 waist-mate] -> all locked.
  * waist slim   : uniform radial slim near the top waist band (z~0.03).
  * hip flare    : smooth ±Y sector push-out in the lower band (z~-0.08) for a
                   wider hip line, blended to zero at the locked hip + waist rings.
"""
import os
import sys

import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(__file__))
import connections as C
import warp2 as W

ROBOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
ORIG = os.path.join(ROBOT, 'assets/profiles/asimov-1/meshes')
OUT = os.path.join(ROBOT, 'cad/asimov-feminine/output/stl')


def _gauss(z, mu, sigma):
    return np.exp(-((z - mu) / sigma) ** 2)


def build_waist_yaw(mesh):
    """Torso: cinch waist, smooth forward bust, ribcage taper, back arch."""
    reserved = C.reserved_levels('WAIST_YAW')  # [0.0, 0.2611, 0.3782]

    # 1) Waist cinch + ribcage taper as one uniform scale_fn.
    #    Cinch dips at the low waist (~0.10); a gentle taper sits just below the
    #    bust (~0.16) so the bust is the widest front feature. Both are uniform
    #    (roundness-safe radial scale about the section centre).
    def scale_fn(z):
        cinch = 1.0 - 0.14 * _gauss(z, 0.10, 0.055)   # waist dip -> ~0.86
        taper = 1.0 - 0.05 * _gauss(z, 0.165, 0.035)  # subtle ribcage taper
        return cinch * taper

    # 2) Bust: push the FRONT (+X) sector outward, centred at z~0.205, below the
    #    shoulder lock (0.2611). Gaussian Z falloff + a wide cosine angular sector
    #    => a swell that grows out of the chest surface and blends back. Gain peak
    #    ~+0.42 on the front radius.
    def bust_gain(z):
        return 1.0 + 0.36 * _gauss(z, 0.198, 0.052)

    bulges = [dict(center=0.0, width=np.pi * 1.05, gain=bust_gain)]

    # 3) Back arch: shift the centreline toward -X (back) in the mid torso, ~12 mm.
    def arch(z):
        return (-0.012 * _gauss(z, 0.165, 0.075), 0.0)

    # Tight ramp so the shoulder lock at 0.2611 doesn't kill the bust at 0.205,
    # yet mating rings stay exact.
    return W.warp_profile(mesh, axis='z', scale_fn=scale_fn, bulges=bulges,
                          shift_fn=arch, reserved=reserved, ramp=0.022)


def build_imu_origin(mesh):
    """Pelvis: slim the waist top, flare the hips outward (±Y) in the lower band."""
    reserved = C.reserved_levels('IMU_ORIGIN')  # [-0.044, 0.0, 0.0748]

    # Slim the upper waist band (near the waist mate) uniformly.
    def scale_fn(z):
        return 1.0 - 0.08 * _gauss(z, 0.030, 0.030)

    # Hip flare: push BOTH ±Y side sectors outward in the lower pelvis band
    # (z~-0.08). Two cosine sectors centred at +Y (pi/2) and -Y (-pi/2). Blends to
    # zero at the locked hip ring (-0.044) and the waist ring (0.075).
    def hip_gain(z):
        return 1.0 + 0.22 * _gauss(z, -0.080, 0.030)

    bulges = [
        dict(center=np.pi / 2, width=np.pi * 0.95, gain=hip_gain),
        dict(center=-np.pi / 2, width=np.pi * 0.95, gain=hip_gain),
    ]

    return W.warp_profile(mesh, axis='z', scale_fn=scale_fn, bulges=bulges,
                          shift_fn=None, reserved=reserved, ramp=0.018)


BUILDERS = {
    'WAIST_YAW': build_waist_yaw,
    'IMU_ORIGIN': build_imu_origin,
}


def run():
    os.makedirs(OUT, exist_ok=True)
    for name, build in BUILDERS.items():
        src = trimesh.load(os.path.join(ORIG, name + '.STL'))
        out = build(src)
        out.export(os.path.join(OUT, name + '.STL'))
        ob, wb = src.bounds, out.bounds
        ratio = [(wb[1][i] - wb[0][i]) / (ob[1][i] - ob[0][i]) for i in range(3)]
        print(f"{name:<12} faces={len(out.faces):>7} "
              f"Xr={ratio[0]:.3f} Yr={ratio[1]:.3f} Zr={ratio[2]:.3f} "
              f"watertight={out.is_watertight}")


if __name__ == '__main__':
    run()
