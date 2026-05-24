"""RIGHT_ELBOW - forearm slim + wrist-ward taper.

Uses the same source-preserving warp as LEFT_ELBOW, applied to the right-side
STL directly so the proof remains hash-bound to this link's own source mesh and
reserved interface slabs.
"""
import sys

sys.path.insert(
    0,
    '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param',
)

import numpy as np
import trimesh

import connections as C
import paramlib as P
import warp2 as W

PART = 'RIGHT_ELBOW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/{PART}.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'
WRIST_JOINT = -0.072635


def femme_forearm(z):
    base = 0.82
    t = np.clip(-z / abs(WRIST_JOINT), 0.0, 1.4)
    return base - 0.08 * t


def build():
    orig = trimesh.load(SRC)
    param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72)
    reserved = C.reserved_levels(PART)
    rebuilt = W.warp_similarity(
        orig,
        axis='z',
        scale_fn=femme_forearm,
        reserved=reserved,
        ramp=0.035,
        step=0.0025,
        smooth_m=5,
    )
    rebuilt = W.separate_quantized_components(
        rebuilt,
        axis='z',
        epsilon=1e-4,
        merge_tolerance=1e-6,
    )
    rebuilt = W.remove_excess_quantized_nonmanifold_faces(
        rebuilt,
        merge_tolerance=1e-6,
    )
    rebuilt = W.cap_quantized_boundary_loops(
        rebuilt,
        merge_tolerance=1e-6,
        max_loop_vertices=128,
    )
    rebuilt.export(OUT)

    ob, rb = orig.bounds, rebuilt.bounds
    print(f"=== {PART} femme warp ===")
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f"  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}")
    print(
        f"  watertight={rebuilt.is_watertight} "
        f"vol orig={orig.volume*1e6:.1f}cm3 femme={rebuilt.volume*1e6:.1f}cm3"
    )
    print(f"  reserved={[round(x, 4) for x in reserved]}")
    return rebuilt


if __name__ == '__main__':
    build()
