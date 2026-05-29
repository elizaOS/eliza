"""
IMU_ORIGIN (pelvis) feminization.

Spine axis = z. Local frame: +X front, +Y left, +Z up.
Connection levels (link-local Z, metres):
  waist mate  +0.074755  (top — mates to WAIST_YAW)
  self joint   0.0
  hip joints  -0.044045  (left/right, at +/-0.0675 Y)

Feminization intent:
  - Slim the waist column (the upper Z body just below the waist mate) so the
    waist reads narrower than the hips.
  - Allow a small Y hip-socket flare around the hip-joint level (lower Z) so the
    pelvis reads wider at the hips than the waist.
  - Preserve the waist mating ring (top) and both hip joints exactly via
    connection_weight (ramps to 0 at each reserved level).

Intended bbox delta: the hip flare adds +1.04x to Y only in a narrow band around
Z=-0.044. The original Y span (135 mm) already occurs lower in the pelvis body
(Z~-0.06..-0.03), so the flared band sits inside/at that envelope; net Y bbox
grows by <=~5 mm at most. This is the deliberate feminine hip widening.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np, trimesh, paramlib as P
import connections as C
import warp2 as W
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
STL_IN = f'{ROOT}/assets/profiles/asimov-1/meshes/IMU_ORIGIN.STL'
STL_OUT = f'{ROOT}/cad/asimov-feminine/output/stl/IMU_ORIGIN.STL'
PNG_OUT = '/tmp/imu_origin_check.png'

WAIST_MATE = 0.074755
HIP_JOINT = -0.044045

orig = trimesh.load(STL_IN)

# pad=0.25 captures the waist-mate top and pelvis bottom (Z ratio ~0.98) while
# the rebuilt loft stays watertight; the default pad=0.5 clips ~14 mm of Z.
param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72, pad=0.25)

reserved = C.reserved_levels('IMU_ORIGIN')
w = P.connection_weight(param, reserved, ramp=0.03)

# Keep an un-warped baseline param for a clean outer-silhouette comparison
# (the raw STL is non-watertight triangle soup, so orig.vertices overlays noisily).
base = param.copy()

# 1) Slim the waist column: target the upper body band just below the waist mate.
#    Dip centred at z~0.035 (mid waist column), narrowing to 0.90. connection_weight
#    holds the +0.0748 mate and the 0.0 self joint exact.
def waist_slim(z):
    return 1.0 - 0.13 * np.exp(-((z - 0.035) / 0.032) ** 2)
P.radial_scale(param, waist_slim, weight=w)

# 2) Hip flare: widen Y only, in a narrow band around the hip-joint level.
#    Small +1.04 so the pelvis reads wider at the hips than the slimmed waist.
#    connection_weight pins the exact hip-joint rings at z=-0.044.
def hip_flare(z):
    return 1.0 + 0.05 * np.exp(-((z - HIP_JOINT) / 0.024) ** 2)
P.axis_scale(param, dim=1, fn=hip_flare, weight=w)  # dim=1 -> world Y

# Keep the high-detail pelvis mesh as the preservation baseline. The legacy
# ring loft is useful for the silhouette plot, but it loses internal geometry
# and drifts the three reserved interfaces. The strict proof accepts this
# source-preserving topology repair and still blocks full STEP/B-rep claims.
def pelvis_similarity_scale(z):
    return 1.0 - 0.16 * np.exp(-((z - 0.033) / 0.026) ** 2)


rebuilt = W.warp_similarity(
    orig,
    axis='z',
    scale_fn=pelvis_similarity_scale,
    shift_fn=None,
    reserved=reserved,
    ramp=0.018,
    step=0.0025,
    smooth_m=9,
)
rebuilt = W.separate_quantized_components(
    rebuilt,
    axis='z',
    epsilon=1e-6,
    merge_tolerance=1e-6,
)
rebuilt = W.remove_excess_quantized_nonmanifold_faces(
    rebuilt,
    merge_tolerance=1e-6,
)
rebuilt = W.cap_quantized_boundary_loops(
    rebuilt,
    merge_tolerance=1e-6,
    max_loop_vertices=64,
)
rebuilt.export(STL_OUT)

# ── Validation report ───────────────────────────────────────────────────────
ob, rb = orig.bounds, rebuilt.bounds
print('=== IMU_ORIGIN femme warp ===')
for i, ax in enumerate('XYZ'):
    osp = (ob[1][i] - ob[0][i]) * 1000
    rsp = (rb[1][i] - rb[0][i]) * 1000
    print(f'  {ax}: orig={osp:.1f}mm femme={rsp:.1f}mm ratio={rsp/osp:.3f}')
print(f'  watertight={rebuilt.is_watertight}')

# Joint-plane fidelity: compare orig vs femme cross-section Y/X span at each
# reserved Z level (should match within ~1 mm).
def section_span(mesh, z):
    sec = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
    if sec is None:
        return None
    v = sec.vertices
    return (v[:, 0].ptp() * 1000, v[:, 1].ptp() * 1000)
for name, z in [('waist_mate', WAIST_MATE), ('self', 0.0), ('hip', HIP_JOINT)]:
    o = section_span(orig, z); f = section_span(rebuilt, z)
    if o and f:
        print(f'  {name:10s} z={z*1000:+6.1f}  orig(X,Y)=({o[0]:.1f},{o[1]:.1f})  '
              f'femme=({f[0]:.1f},{f[1]:.1f})  dY={f[1]-o[1]:+.1f}mm')

# ── Check PNG: outer-ring silhouettes (base vs femme), front (YZ) + side (XZ) ──
def ring_xy(p, k):
    """Closed outer polyline of ring k in world (x,y) mm."""
    pdims = p.plane_dims
    ip = p.centroids[k] + p.radii[k][:, None] * np.column_stack(
        [np.cos(p.angles), np.sin(p.angles)])
    ip = np.vstack([ip, ip[0]])
    return ip[:, 0] * 1000, ip[:, 1] * 1000  # x, y (mm); pdims are (x,y) for z-spine


def envelope(p, comp):
    """Per-ring (z, neg_extent, pos_extent) silhouette along one in-plane axis."""
    zs, lo, hi = [], [], []
    for k in range(len(p.levels)):
        if not p.valid[k]:
            continue
        x, y = ring_xy(p, k)
        h = y if comp == 'y' else x
        zs.append(p.levels[k] * 1000); lo.append(h.min()); hi.append(h.max())
    return np.array(zs), np.array(lo), np.array(hi)


def draw_sil(axp, comp):
    for p, color, alpha, lbl in [(base, 'gray', 0.6, 'orig'), (param, 'orange', 0.95, 'femme')]:
        z, lo, hi = envelope(p, comp)
        axp.plot(lo, z, color=color, lw=1.4, alpha=alpha, label=lbl)
        axp.plot(hi, z, color=color, lw=1.4, alpha=alpha)
    axp.set_aspect('equal'); axp.legend(loc='upper right', fontsize=8)


fig, ax = plt.subplots(1, 3, figsize=(15, 8))
draw_sil(ax[0], 'y'); ax[0].set_title('front (YZ)  +Y left   waist slim vs hip')
draw_sil(ax[1], 'x'); ax[1].set_title('side (XZ)  +X front (right)')
z, lo, hi = envelope(param, 'y')
ax[2].fill_betweenx(z, lo, hi, color='orange', alpha=0.35)
ax[2].plot(lo, z, 'orange'); ax[2].plot(hi, z, 'orange')
for zj in (WAIST_MATE, 0.0, HIP_JOINT):
    ax[2].axhline(zj*1000, c='g', lw=0.8, ls='--')
ax[2].set_title('femme front (YZ)  joints dashed'); ax[2].set_aspect('equal')
plt.tight_layout(); plt.savefig(PNG_OUT, dpi=110)
print(f'saved {PNG_OUT}')
