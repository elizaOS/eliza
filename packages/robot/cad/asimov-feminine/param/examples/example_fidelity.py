import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np
import trimesh
import paramlib as P

STL = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/assets/profiles/asimov-1/meshes/LEFT_KNEE.STL'
orig = trimesh.load(STL)
print(f"ORIG: verts={len(orig.vertices)} faces={len(orig.faces)} bounds={orig.bounds.round(4).tolist()}")

# Extract parametric (spine along Z, the long axis)
param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72)
nvalid = param.valid.sum()
print(f"PARAM: {len(param.levels)} levels, {nvalid} valid rings, {len(param.angles)} angles")
print(f"  Z range: {param.levels[param.valid].min():.4f}..{param.levels[param.valid].max():.4f}")
print(f"  mean radius: {param.radii[param.valid].mean()*1000:.1f}mm")

# Rebuild without warp — fidelity check
rebuilt = P.rings_to_mesh(param)
print(f"REBUILT: verts={len(rebuilt.vertices)} faces={len(rebuilt.faces)} watertight={rebuilt.is_watertight}")
print(f"  bounds={rebuilt.bounds.round(4).tolist()}")

# Compare bounding boxes
ob = orig.bounds; rb = rebuilt.bounds
for i, ax in enumerate('XYZ'):
    osp = (ob[1][i]-ob[0][i])*1000; rsp = (rb[1][i]-rb[0][i])*1000
    print(f"  {ax}: orig_span={osp:.1f}mm rebuilt_span={rsp:.1f}mm ratio={rsp/osp:.3f}")

# Volume comparison
print(f"  orig vol={orig.volume*1e6:.1f}cm³  rebuilt vol={rebuilt.volume*1e6:.1f}cm³")

rebuilt.export('/tmp/LEFT_KNEE_rebuilt.stl')
print("exported /tmp/LEFT_KNEE_rebuilt.stl")
