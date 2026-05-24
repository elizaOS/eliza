"""LEFT_ELBOW — forearm slim + wrist-ward taper.

Feminize the forearm shaft: slim it overall and taper it thinner toward the
wrist end. Spine = z (per connections.py). Reserved levels: elbow joint at
z=0 and wrist child at z=-0.072635 — both kept exact via connection_weight so
the joints still mate. Slimming only shrinks radii, so we stay inside the
original bounding box on every axis.
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

PART = 'LEFT_ELBOW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/{PART}.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'
PNG = f'/tmp/{PART.lower()}_check.png'

# Reserved spine-axis levels: elbow joint (0.0) + wrist child (-0.072635).
ELBOW_JOINT = 0.0
WRIST_JOINT = -0.072635
reserved = reserved_levels(PART)  # [-0.072635, 0.0]


def femme_forearm(z):
    """Slim ~0.82 at the elbow end, taper to ~0.74 at the wrist end.

    z runs from the elbow joint (z=0) down to / past the wrist (z=-0.0726).
    Lower z = closer to the wrist = slimmer. connection_weight pins the
    radii back to original at z=0 and z=-0.0726, so this target is the
    free-body shape between/around the joints.
    """
    base = 0.82
    # taper: 0 at elbow, 1 at wrist level; extrapolates mildly past the wrist
    t = np.clip(-z / abs(WRIST_JOINT), 0.0, 1.4)
    return base - 0.08 * t  # 0.82 → ~0.71 at the far hand stub


def build():
    orig = trimesh.load(SRC)
    param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72)
    w = P.connection_weight(param, reserved, ramp=0.035)
    P.radial_scale(param, femme_forearm, weight=w)
    rebuilt = P.rings_to_mesh(param)
    rebuilt.export(OUT)

    ob, rb = orig.bounds, rebuilt.bounds
    print(f"=== {PART} femme warp ===")
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f"  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}")
    print(f"  watertight={rebuilt.is_watertight} "
          f"vol orig={orig.volume*1e6:.1f}cm3 femme={rebuilt.volume*1e6:.1f}cm3")

    # Joint-plane preservation check: bbox radius near each reserved level.
    pdims = param.plane_dims
    for rl, nm in [(ELBOW_JOINT, 'elbow'), (WRIST_JOINT, 'wrist')]:
        k = int(np.argmin(np.abs(param.levels - rl)))
        opm = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72)
        # max radial extent of orig vs femme at that ring
        of = opm.radii[k].max() * 1000
        ff = param.radii[k].max() * 1000
        print(f"  joint[{nm}] z={rl*1000:.1f}mm maxR orig={of:.2f} femme={ff:.2f} d={abs(of-ff):.3f}mm")

    # Overlay orig (gray) vs femme (orange) in all three views so the forearm
    # cross-section slimming is visible. The link is L-shaped (forearm in +X,
    # elbow yoke at z~0) so no single view is a clean silhouette; the XY top
    # view shows the forearm shaft thinning, which is the feminizing intent.
    ov, rv = orig.vertices, rebuilt.vertices
    fig, ax = plt.subplots(1, 3, figsize=(14, 6))
    views = [((0, 1), 'top XY (forearm shaft)'), ((0, 2), 'side XZ'), ((1, 2), 'front YZ (wrist x-section)')]
    for axi, ((d0, d1), title) in zip(ax, views):
        axi.scatter(ov[:, d0]*1000, ov[:, d1]*1000, s=0.3, c='gray', alpha=0.4, label='orig')
        axi.scatter(rv[:, d0]*1000, rv[:, d1]*1000, s=0.3, c='orange', alpha=0.55, label='femme')
        axi.set_title(title); axi.set_aspect('equal')
    ax[0].legend(markerscale=8)
    plt.tight_layout(); plt.savefig(PNG, dpi=80)
    print(f"saved {PNG}")
    return rebuilt


if __name__ == '__main__':
    build()
