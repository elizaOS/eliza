"""
Regenerate ALL femme parts by CONSTRAINT-BASED uniform similarity warp.

Each part's cross-sections are scaled UNIFORMLY about their smooth outer-boundary
centreline (warp2.warp_similarity) so round features stay round; connection
levels are locked so parts still mate; original triangles are preserved.

This pass is slim-only (roundness-safe). Curves (bust/hips) are layered in a
separate constrained pass once this foundation is verified.

Run:  .venv/bin/python cad/asimov-feminine/param/regen_all.py
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np, trimesh
import warp2 as W
import connections as C

ROBOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
ORIG = os.path.join(ROBOT, 'assets/profiles/asimov-1/meshes')
OUT = os.path.join(ROBOT, 'cad/asimov-feminine/output/stl')

# Per-part uniform slim factor (1.0 = unchanged). Roundness preserved for all.
SLIM = {
    'IMU_ORIGIN': 1.00,          # pelvis: keep (curves added later)
    'WAIST_YAW': 1.00,           # torso: keep (bust/cinch added later)
    'NECK_YAW': 0.88,            # slender neck
    'NECK_PITCH': 0.94,          # head: gentle slim
    'LEFT_HIP_PITCH': 0.97, 'LEFT_HIP_ROLL': 0.97, 'LEFT_HIP_YAW': 0.90,
    'LEFT_KNEE': 0.86,           # calf/thigh shaft slim
    'LEFT_ANKLE_A': 0.92, 'LEFT_ANKLE_B': 0.93, 'LEFT_TOE': 0.96,
    'LEFT_SHOULDER_PITCH': 0.97, # keep some pauldron
    'LEFT_SHOULDER_ROLL': 0.84, 'LEFT_SHOULDER_YAW': 0.83,
    'LEFT_ELBOW': 0.83, 'LEFT_WRIST_YAW': 0.82,
}
# mirror left->right
for k in list(SLIM.keys()):
    if k.startswith('LEFT_'):
        SLIM[k.replace('LEFT_', 'RIGHT_')] = SLIM[k]


def big_facet_planarity(mesh, topn=4):
    """Max planar deviation (mm) across the largest flat facets — should be ~0."""
    fa = mesh.facets_area
    if not len(fa):
        return 0.0
    worst = 0.0
    for idx in np.argsort(fa)[::-1][:topn]:
        vids = np.unique(mesh.faces[mesh.facets[idx]].ravel())
        pts = mesh.vertices[vids]
        c = pts.mean(0); _, _, vt = np.linalg.svd(pts - c)
        worst = max(worst, np.abs((pts - c) @ vt[2]).max() * 1000)
    return worst


def run():
    t0 = time.time()
    print(f"{'PART':<22}{'spine':>6}{'faces':>8}{'slim':>6}{'Xr':>7}{'Yr':>7}{'Zr':>7}{'flat_dev':>9}")
    for name, factor in SLIM.items():
        spec = C.LINKS[name]
        axis = spec['spine']
        m = trimesh.load(os.path.join(ORIG, name + '.STL'))
        if factor == 1.0:
            warped = m.copy()  # untouched this pass (curves added separately)
        else:
            # Constant affine: scale the two non-spine dims about the joint axis.
            # Keeps flat plates flat + spine bores round, preserves length.
            warped = W.warp_affine(m, spine=axis, factor=factor, center=(0.0, 0.0))
        warped.export(os.path.join(OUT, name + '.STL'))
        ob, wb = m.bounds, warped.bounds
        r = [(wb[1][i]-wb[0][i])/(ob[1][i]-ob[0][i]) for i in range(3)]
        dev = big_facet_planarity(warped)
        print(f"{name:<22}{axis:>6}{len(warped.faces):>8}{factor:>6.2f}"
              f"{r[0]:>7.3f}{r[1]:>7.3f}{r[2]:>7.3f}{dev:>8.4f}m")
    print(f"DONE in {time.time()-t0:.0f}s — constant affine slim: planes stay flat, bores stay round.")


if __name__ == '__main__':
    run()
