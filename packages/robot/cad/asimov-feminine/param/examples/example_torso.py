import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np, trimesh, paramlib as P
import connections as C
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

STL = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/assets/profiles/asimov-1/meshes/WAIST_YAW.STL'
orig = trimesh.load(STL)
print("WAIST bounds (mm):", (orig.bounds*1000).round(1).tolist())

param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=96)
print("rings:", param.valid.sum(), "Zrange:",
      round(param.levels[param.valid].min(),3), round(param.levels[param.valid].max(),3))

reserved = C.reserved_levels('WAIST_YAW')
print("reserved Z levels:", [round(r,3) for r in reserved])
w = P.connection_weight(param, reserved, ramp=0.05)

# In WAIST_YAW local frame: +X = front (chest faces +X), +Z = up.
# Angle 0 = +X (front). So bust = sector around angle 0.
# 1) Cinch waist: radial slim in low-mid Z (waist ~0.10-0.18)
def waist_cinch(z):
    # smooth dip centered at z=0.14
    return 1.0 - 0.12 * np.exp(-((z - 0.14)/0.05)**2)
P.radial_scale(param, waist_cinch, weight=w)

# 2) Bust: push front sector (+X, angle 0) outward in upper-mid Z (0.22-0.31)
def bust(z):
    return 1.0 + 0.35 * np.exp(-((z - 0.265)/0.035)**2)
P.sector_scale(param, ang_center=0.0, ang_width=np.pi*0.9, fn=bust, weight=w)

# 3) Back arch: shift centroid -X (back, since front is +X) in mid torso
def arch(z):
    dx = -0.012 * np.exp(-((z - 0.20)/0.07)**2)  # gentle 12mm arch
    return (dx, 0.0)
P.spine_shift(param, arch, weight=w)

rebuilt = P.rings_to_mesh(param)
rebuilt.export('/tmp/WAIST_femme.stl')
ob, rb = orig.bounds, rebuilt.bounds
for i, ax in enumerate('XYZ'):
    osp=(ob[1][i]-ob[0][i])*1000; rsp=(rb[1][i]-rb[0][i])*1000
    print(f"  {ax}: orig={osp:.1f} femme={rsp:.1f} ratio={rsp/osp:.3f}")
print("watertight:", rebuilt.is_watertight)

fig, ax = plt.subplots(1, 3, figsize=(14, 8))
ov, rv = orig.vertices, rebuilt.vertices
ax[0].scatter(ov[:,0]*1000, ov[:,2]*1000, s=0.3, c='gray'); ax[0].set_title('ORIG side (XZ) front=right'); ax[0].set_aspect('equal')
ax[1].scatter(rv[:,0]*1000, rv[:,2]*1000, s=0.4, c='orange'); ax[1].set_title('FEMME side (XZ)'); ax[1].set_aspect('equal')
ax[2].scatter(rv[:,1]*1000, rv[:,2]*1000, s=0.4, c='orange'); ax[2].set_title('FEMME front (YZ)'); ax[2].set_aspect('equal')
plt.tight_layout(); plt.savefig('/tmp/torso_femme_check.png', dpi=80)
print("saved /tmp/torso_femme_check.png")
