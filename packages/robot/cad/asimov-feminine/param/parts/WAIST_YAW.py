"""
WAIST_YAW — chest/torso column feminization.

Local frame: +X = front (chest faces +X), +Y = robot left, +Z = up.
Spine axis = z. Angle 0 in a z-slice = +X (front).

The stock WAIST_YAW.STL is a 16-body, non-watertight mesh full of internal
structure, shoulder mounts and the front "M" cutout. The library's default
"largest single section loop" slicer latches onto unrelated fragments level to
level, producing a jagged, lumpy spine (this is what "ruined the torso" before).
We instead extract the CONVEX HULL of every section's points — the true outer
torso envelope — which is smooth, monotonic and watertight when lofted, and which
correctly ignores the internal cutouts the spec tells us to drop. Everything else
(warp helpers, weights, loft) is stock `paramlib`.

Feminization (integrated surface warps — NO glued primitives):
  1. Waist cinch   — gentle uniform radial slim in lower-mid Z (~0.10-0.18).
  2. Bust          — push the FRONT (+X, angle 0) angular sector outward in
                     upper-mid Z as a smooth swell of the chest surface
                     (sector_scale; cosine angular falloff -> blends into torso).
  3. Back arch     — shift ring centroid -X (back) in the mid torso (spine_shift).
  4. Ribcage taper — slim above the bust toward the neck.

Connection rings preserved via connection_weight at reserved levels
Z = {0.0 (waist mate), 0.261 (both shoulders), 0.378 (neck)}.

Intended bbox deltas: Y/Z preserved. Front (+X) may exceed the stock 101.6 mm
front by the bust swell only (target < +25 mm forward); the rest of X is preserved.
"""
import sys
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
sys.path.insert(0, ROOT + '/cad/asimov-feminine/param')
import numpy as np
import trimesh
import paramlib as P
import connections as C
from shapely.geometry import MultiPoint, LineString
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ORIG_STL = ROOT + '/assets/profiles/asimov-1/meshes/WAIST_YAW.STL'
OUT_STL = ROOT + '/cad/asimov-feminine/output/stl/WAIST_YAW.STL'
CHECK_PNG = '/tmp/waist_yaw_check.png'

N_ANGULAR = 96

# ── Warp amplitudes (tuned by silhouette inspection) ──────────────────────────
WAIST_Z = 0.145       # waist cinch centre (m)
WAIST_SIGMA = 0.040
WAIST_DEPTH = 0.12    # 1 - 0.12 = 0.88 min radial multiplier at the cinch

BUST_Z = 0.242        # bust peak centre (m) — below the 0.261 shoulder ring
BUST_SIGMA = 0.034    # vertical falloff of the swell (softer = rounder, less pointy)
BUST_AMP = 0.40       # peak front-sector multiplier (+40%)
BUST_WIDTH = np.pi * 0.78  # ~140deg: frontal swell, keeps side width ~1.0

ARCH_Z = 0.180        # back-arch centre (m)
ARCH_SIGMA = 0.060
ARCH_PEAK = 0.013     # 13 mm rearward (-X) centroid shift at peak

RIB_Z = 0.300         # ribcage taper centre (above bust, toward neck)
RIB_SIGMA = 0.035
RIB_DEPTH = 0.07      # gentle 7% slim


def slice_to_hull_rings(mesh, axis='z', step=0.01, n_angular=96, pad=0.5):
    """Like paramlib.slice_to_rings but each ring is the CONVEX HULL of all
    section points (robust outer envelope for fragmented multi-body meshes)."""
    a = P.AXIS_IDX[axis]
    pdims = [d for d in range(3) if d != a]
    lo, hi = mesh.bounds[0][a], mesh.bounds[1][a]
    levels = np.arange(lo + step * pad, hi, step)
    angles = np.linspace(0, 2 * np.pi, n_angular, endpoint=False)
    normal = np.zeros(3); normal[a] = 1.0
    K = len(levels)
    centroids = np.zeros((K, 2))
    radii = np.zeros((K, n_angular))
    valid = np.zeros(K, dtype=bool)

    for k, lvl in enumerate(levels):
        origin = np.zeros(3); origin[a] = lvl
        sec = mesh.section(plane_origin=origin, plane_normal=normal)
        if sec is None:
            continue
        pts = np.vstack([pl[:, pdims] for pl in sec.discrete if len(pl) >= 2])
        if len(pts) < 3:
            continue
        hull = MultiPoint([tuple(p) for p in pts]).convex_hull
        if hull.geom_type != 'Polygon':
            continue
        c = np.array(hull.centroid.coords[0])
        centroids[k] = c
        reach = max(hull.bounds[2] - hull.bounds[0],
                    hull.bounds[3] - hull.bounds[1]) * 2 + 1e-3
        boundary = hull.boundary
        for j, ang in enumerate(angles):
            d = np.array([np.cos(ang), np.sin(ang)])
            far = c + d * reach
            inter = LineString([tuple(c), tuple(far)]).intersection(boundary)
            if inter.is_empty:
                continue
            if inter.geom_type == 'Point':
                ps = [np.array(inter.coords[0])]
            elif inter.geom_type in ('MultiPoint', 'GeometryCollection'):
                ps = [np.array(g.coords[0]) for g in inter.geoms if g.geom_type == 'Point']
            elif inter.geom_type == 'LineString':
                ps = [np.array(p) for p in inter.coords]
            else:
                ps = []
            radii[k, j] = max((np.linalg.norm(p - c) for p in ps), default=0.0)
        valid[k] = radii[k].max() > 0

    return P.PartParam(axis, levels, centroids, radii, angles, valid)


def build():
    orig = trimesh.load(ORIG_STL)
    param = slice_to_hull_rings(orig, axis='z', step=0.01, n_angular=N_ANGULAR)

    reserved = C.reserved_levels('WAIST_YAW')
    w = P.connection_weight(param, reserved, ramp=0.04)

    # 1) Waist cinch — uniform radial slim, smooth Gaussian dip.
    def waist_cinch(z):
        return 1.0 - WAIST_DEPTH * np.exp(-((z - WAIST_Z) / WAIST_SIGMA) ** 2)
    P.radial_scale(param, waist_cinch, weight=w)

    # 4) Ribcage taper above the bust toward the neck (before bust so the swell
    #    rides cleanly on the tapered ribcage).
    def rib_taper(z):
        return 1.0 - RIB_DEPTH * np.exp(-((z - RIB_Z) / RIB_SIGMA) ** 2)
    P.radial_scale(param, rib_taper, weight=w)

    # 2) Bust — front (+X) sector swell, integrated into the chest surface.
    def bust(z):
        return 1.0 + BUST_AMP * np.exp(-((z - BUST_Z) / BUST_SIGMA) ** 2)
    P.sector_scale(param, ang_center=0.0, ang_width=BUST_WIDTH, fn=bust, weight=w)

    # 3) Back arch — shift centroid -X (back) in the mid torso.
    def arch(z):
        dx = -ARCH_PEAK * np.exp(-((z - ARCH_Z) / ARCH_SIGMA) ** 2)
        return (dx, 0.0)
    P.spine_shift(param, arch, weight=w)

    rebuilt = P.rings_to_mesh(param)
    return orig, param, rebuilt, reserved


def ring_profile(param):
    """front(+X), back(-X), left(+Y), right(-Y) boundary positions per valid
    ring (mm), straight from the angular radii — clean silhouette, no triangles."""
    ang = param.angles

    def jidx(target):
        return int(np.argmin(np.abs(((ang - target + np.pi) % (2 * np.pi)) - np.pi)))
    jf, jb = jidx(0.0), jidx(np.pi)
    jl, jr = jidx(np.pi / 2), jidx(3 * np.pi / 2)
    cx = param.centroids[:, 0] * 1000
    cy = param.centroids[:, 1] * 1000
    r = param.radii * 1000
    v = param.valid
    return (param.levels[v] * 1000,
            (cx + r[:, jf])[v], (cx - r[:, jb])[v],
            (cy + r[:, jl])[v], (cy - r[:, jr])[v])


def param_extents_at(param, z):
    """(xmin,xmax,ymin,ymax) mm of the ring nearest spine level z (m)."""
    k = int(np.argmin(np.abs(param.levels - z)))
    if not param.valid[k]:
        return None
    ang = param.angles
    pts = param.centroids[k] + param.radii[k][:, None] * np.stack(
        [np.cos(ang), np.sin(ang)], axis=1)
    pts *= 1000
    return (pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max())


def validate(orig, param_orig, param_femme, rebuilt, reserved):
    print("=== WAIST_YAW validation ===")
    print("watertight:", rebuilt.is_watertight)
    ob, rb = orig.bounds, rebuilt.bounds
    ratios = {}
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        ratios[ax] = rsp / osp
        print(f"  {ax}: orig={osp:7.1f}  femme={rsp:7.1f}  ratio={rsp / osp:.3f}")
    fwd = (rb[1][0] - ob[1][0]) * 1000
    print(f"  front (+X) protrusion vs stock bbox: {fwd:+.1f} mm")

    print("  connection-ring extents (orig-hull vs femme), mm [xmin xmax ymin ymax]:")
    ring_ok = True
    for z in reserved:
        eo = param_extents_at(param_orig, z)
        er = param_extents_at(param_femme, z)
        if eo is None or er is None:
            print(f"    Z={z:.3f}: missing ring (orig={eo} femme={er})")
            ring_ok = False
            continue
        dmax = max(abs(a - b) for a, b in zip(eo, er))
        flag = '' if dmax <= 1.0 else '  <-- DRIFT'
        if dmax > 1.0:
            ring_ok = False
        print(f"    Z={z:.3f}: orig=[{eo[0]:6.1f} {eo[1]:6.1f} {eo[2]:6.1f} {eo[3]:6.1f}] "
              f"femme=[{er[0]:6.1f} {er[1]:6.1f} {er[2]:6.1f} {er[3]:6.1f}] "
              f"maxd={dmax:.2f}mm{flag}")
    return ratios, ring_ok


def render_check(param_orig, param_femme):
    fig, ax = plt.subplots(1, 2, figsize=(11, 8))
    zo, fo, bo, lo, ro = ring_profile(param_orig)
    zf, ff, bf, lf, rf = ring_profile(param_femme)

    ax[0].plot(fo, zo, '--', c='gray', lw=1.2, label='orig front (+X)')
    ax[0].plot(bo, zo, '--', c='lightgray', lw=1.2, label='orig back (-X)')
    ax[0].plot(ff, zf, '-', c='crimson', lw=2.0, label='femme front (+X)')
    ax[0].plot(bf, zf, '-', c='steelblue', lw=2.0, label='femme back (-X)')
    for zline in (0, 261, 378):
        ax[0].axhline(zline, c='green', ls=':', lw=0.8)
    ax[0].set_title('SIDE (XZ): chest profile  front=right')
    ax[0].set_xlabel('X (mm)  front=+'); ax[0].set_ylabel('Z (mm)')
    ax[0].set_aspect('equal'); ax[0].legend(fontsize=7); ax[0].grid(alpha=0.2)

    ax[1].plot(lo, zo, '--', c='gray', lw=1.2, label='orig left (+Y)')
    ax[1].plot(ro, zo, '--', c='lightgray', lw=1.2, label='orig right (-Y)')
    ax[1].plot(lf, zf, '-', c='crimson', lw=2.0, label='femme left (+Y)')
    ax[1].plot(rf, zf, '-', c='steelblue', lw=2.0, label='femme right (-Y)')
    for zline in (0, 261, 378):
        ax[1].axhline(zline, c='green', ls=':', lw=0.8)
    ax[1].set_title('FRONT (YZ): waist/width profile')
    ax[1].set_xlabel('Y (mm)  left=+'); ax[1].set_ylabel('Z (mm)')
    ax[1].set_aspect('equal'); ax[1].legend(fontsize=7); ax[1].grid(alpha=0.2)

    plt.tight_layout()
    plt.savefig(CHECK_PNG, dpi=90)
    print("saved", CHECK_PNG)


if __name__ == '__main__':
    orig = trimesh.load(ORIG_STL)
    param_orig = slice_to_hull_rings(orig, axis='z', step=0.01, n_angular=N_ANGULAR)

    orig, param_femme, rebuilt, reserved = build()
    rebuilt.export(OUT_STL)
    print("wrote", OUT_STL)

    ratios, ring_ok = validate(orig, param_orig, param_femme, rebuilt, reserved)
    render_check(param_orig, param_femme)

    ok = (rebuilt.is_watertight
          and abs(ratios['Y'] - 1.0) < 0.03
          and ratios['Z'] > 0.96
          and ring_ok)
    print("ALL CHECKS PASS:" if ok else "CHECKS FAILED:", ok)
