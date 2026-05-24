"""RIGHT_WRIST_YAW — dainty wrist/hand slim from the right source mesh.

Build from the right source STL directly so proof hashes and surface-distance
checks are bound to the actual right-hand geometry, not a mirrored left mesh.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np
import trimesh
import warp2 as W
from connections import reserved_levels

PART = 'RIGHT_WRIST_YAW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/{PART}.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'
reserved = reserved_levels(PART)


def femme_hand(z):
    base = 0.80
    t = np.clip(z / 0.017, 0.0, 1.0)
    return base - 0.06 * t


def build():
    orig = trimesh.load(SRC)
    right = W.warp_similarity(
        orig,
        axis='z',
        scale_fn=femme_hand,
        reserved=reserved,
        ramp=0.012,
        step=0.0025,
        smooth_m=5,
    )
    right.export(OUT)
    ob = orig.bounds
    rb = right.bounds
    print(f"=== {PART} femme warp ===")
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f"  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}")
    print(f"  watertight={right.is_watertight} vol={right.volume*1e6:.2f}cm3")
    return right


if __name__ == '__main__':
    build()
