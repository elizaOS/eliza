import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np, trimesh, paramlib as P
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

STL = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/assets/profiles/asimov-1/meshes/LEFT_KNEE.STL'
orig = trimesh.load(STL)

# Connection points in link-local Z (metres): knee joint at top, ankle joint at bottom
KNEE_JOINT = 0.0
ANKLE_JOINT = -0.294662
reserved = [KNEE_JOINT, ANKLE_JOINT]

param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72)
w = P.connection_weight(param, reserved, ramp=0.04)

# Feminize: slim the calf shaft. Thinnest at mid-calf, blends to 1.0 at joints.
# Mid-calf is around Z=-0.15. Use a smooth dip to 0.80.
def calf_slim(z):
    return 0.82  # uniform target; connection_weight handles the joint blend

P.radial_scale(param, calf_slim, weight=w)

rebuilt = P.rings_to_mesh(param)
rebuilt.export('/tmp/LEFT_KNEE_femme.stl')

ob, rb = orig.bounds, rebuilt.bounds
print("=== LEFT_KNEE femme warp ===")
for i, ax in enumerate('XYZ'):
    osp = (ob[1][i]-ob[0][i])*1000; rsp = (rb[1][i]-rb[0][i])*1000
    print(f"  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}")
print(f"  watertight={rebuilt.is_watertight} vol orig={orig.volume*1e6:.0f}cm³ femme={rebuilt.volume*1e6:.0f}cm³")

# Render comparison
fig, ax = plt.subplots(1, 3, figsize=(13, 7))
ov, rv = orig.vertices, rebuilt.vertices
ax[0].scatter(ov[:,1]*1000, ov[:,2]*1000, s=0.3, c='gray'); ax[0].set_title('ORIG front (YZ)'); ax[0].set_aspect('equal')
ax[1].scatter(rv[:,1]*1000, rv[:,2]*1000, s=0.4, c='orange'); ax[1].set_title('FEMME front (YZ)'); ax[1].set_aspect('equal')
# overlay both silhouettes
ax[2].scatter(ov[:,1]*1000, ov[:,2]*1000, s=0.3, c='gray', alpha=0.4, label='orig')
ax[2].scatter(rv[:,1]*1000, rv[:,2]*1000, s=0.3, c='orange', alpha=0.5, label='femme')
ax[2].axhline(KNEE_JOINT*1000, c='g', lw=0.8, ls='--'); ax[2].axhline(ANKLE_JOINT*1000, c='b', lw=0.8, ls='--')
ax[2].set_title('overlay (joints dashed)'); ax[2].set_aspect('equal'); ax[2].legend()
plt.tight_layout(); plt.savefig('/tmp/knee_femme_check.png', dpi=80)
print("saved /tmp/knee_femme_check.png")
