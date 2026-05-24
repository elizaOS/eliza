"""LEFT_WRIST_YAW — dainty wrist/hand slim.

Slim the wrist/hand link (~0.80) for a dainty hand, tapering slightly thinner
toward the hand end (higher z, away from the wrist mate). Spine = z. Reserved
level: the wrist mate at z=0 (the parent interface) is pinned exact via
connection_weight. Slimming only shrinks radii so we stay inside the original
bbox. The part is small (~40 mm) so a finer slice step gives a smoother loft.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np
import trimesh
import paramlib as P
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from connections import reserved_levels

PART = 'LEFT_WRIST_YAW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/{PART}.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'
PNG = f'/tmp/{PART.lower()}_check.png'

WRIST_MATE = 0.0
reserved = reserved_levels(PART)  # [0.0]

# Finer step than the 1 cm default: the link is only ~40 mm tall, so 5 mm
# slices give enough rings (≈8) for a smooth loft without changing the method.
STEP = 0.005


def femme_hand(z):
    """Slim ~0.80, tapering to ~0.74 toward the hand end (higher z).

    connection_weight pins the radii to original at the wrist mate (z=0), so
    this is the free-body target for the hand above the mate.
    """
    base = 0.80
    t = np.clip(z / 0.017, 0.0, 1.0)  # 0 at mate, 1 at hand tip (~+17 mm)
    return base - 0.06 * t


def build():
    orig = trimesh.load(SRC)
    param = P.slice_to_rings(orig, axis='z', step=STEP, n_angular=72)
    w = P.connection_weight(param, reserved, ramp=0.012)
    P.radial_scale(param, femme_hand, weight=w)
    rebuilt = P.rings_to_mesh(param)
    rebuilt.export(OUT)

    ob, rb = orig.bounds, rebuilt.bounds
    print(f"=== {PART} femme warp ===")
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f"  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}")
    print(f"  watertight={rebuilt.is_watertight} "
          f"vol orig={orig.volume*1e6:.2f}cm3 femme={rebuilt.volume*1e6:.2f}cm3")

    k = int(np.argmin(np.abs(param.levels - WRIST_MATE)))
    of = P.slice_to_rings(orig, axis='z', step=STEP, n_angular=72).radii[k].max() * 1000
    ff = param.radii[k].max() * 1000
    print(f"  joint[wrist] z={WRIST_MATE*1000:.1f}mm maxR orig={of:.2f} femme={ff:.2f} d={abs(of-ff):.3f}mm")

    ov, rv = orig.vertices, rebuilt.vertices
    fig, ax = plt.subplots(1, 3, figsize=(13, 6))
    views = [((1, 2), 'front YZ'), ((0, 2), 'side XZ'), ((0, 1), 'top XY')]
    for axi, ((d0, d1), title) in zip(ax, views):
        axi.scatter(ov[:, d0]*1000, ov[:, d1]*1000, s=0.6, c='gray', alpha=0.4, label='orig')
        axi.scatter(rv[:, d0]*1000, rv[:, d1]*1000, s=0.6, c='orange', alpha=0.6, label='femme')
        axi.set_title(title); axi.set_aspect('equal')
    ax[0].axhline(WRIST_MATE*1000, c='b', lw=0.8, ls='--')
    ax[0].legend(markerscale=6)
    plt.tight_layout(); plt.savefig(PNG, dpi=80)
    print(f"saved {PNG}")
    return rebuilt


if __name__ == '__main__':
    build()
