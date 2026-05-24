"""
NECK_PITCH — feminize the head/skull via parametric spine+ring loft.

Spine = Z (local frame +X front, +Y left, +Z up). The head spans Z ~-46..124 mm:
the chin/jaw protrudes forward (+X) in the lower rings, the neck mate sits near
Z=0, and the cranium is the upper volume (Z>50). Reserved levels: [0.0] only —
the bottom neck mate must stay exact (head end has no child joint).

Feminization: slim the jaw/cheek band (~0.88) in the lower-mid region while
KEEPING full cranium volume up top. A smooth Z-profile multiplier dips to 0.88
across the jaw/cheek band and returns to 1.0 over the cranium; connection_weight
pins the neck mate ring.

Slimmed axes (jaw/cheek) shrink inward, staying inside the original bbox. The
cranium is unchanged (mult 1.0), so the upper bbox is preserved.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np
import trimesh
import paramlib as P
import connections as C

ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/NECK_PITCH.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/NECK_PITCH.STL'

JAW_SLIM = 0.88     # slim factor for the jaw/cheek band
# Band geometry along Z (metres). Jaw/cheek centred ~0.01 m, cranium >= ~0.055 m.
BAND_CENTER = 0.010
BAND_HALF = 0.040   # full-slim half-width
CRANIUM_BLEND = 0.030  # ramp back to 1.0 above the band (toward the cranium)


def jaw_profile(z):
    """1.0 over the cranium, dipping to JAW_SLIM across the jaw/cheek band.
    Smoothstep edges keep the loft C1-continuous (no faceting at the band)."""
    d = z - BAND_CENTER
    if d <= -BAND_HALF:                 # below the jaw band (chin tip): blend up
        t = np.clip((-d - BAND_HALF) / CRANIUM_BLEND, 0.0, 1.0)
        s = t * t * (3 - 2 * t)
        return JAW_SLIM + (1.0 - JAW_SLIM) * s
    if abs(d) <= BAND_HALF:             # full jaw/cheek slim
        return JAW_SLIM
    # above the band: ramp back to full cranium volume
    t = np.clip((d - BAND_HALF) / CRANIUM_BLEND, 0.0, 1.0)
    s = t * t * (3 - 2 * t)
    return JAW_SLIM + (1.0 - JAW_SLIM) * s


def build():
    orig = trimesh.load(SRC)
    reserved = C.reserved_levels('NECK_PITCH')  # [0.0]

    # pad=0.05 so the chin tip (low Z) and crown (high Z) extremes are captured
    # and the bottom neck mate plane (~Z=0) stays in the loft.
    param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72, pad=0.05)
    w = P.connection_weight(param, reserved, ramp=0.03)

    P.radial_scale(param, jaw_profile, weight=w)

    rebuilt = P.rings_to_mesh(param)
    rebuilt.export(OUT)
    return orig, rebuilt, reserved


if __name__ == '__main__':
    orig, rebuilt, reserved = build()
    ob, rb = orig.bounds, rebuilt.bounds
    print('=== NECK_PITCH femme ===  reserved', [round(r, 4) for r in reserved])
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f'  {ax}: orig={osp:6.1f}mm femme={rsp:6.1f}mm ratio={rsp / osp:.3f}')
    print(f'  watertight={rebuilt.is_watertight}')
