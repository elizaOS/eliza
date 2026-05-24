"""
NECK_YAW — feminize the neck base via parametric spine+ring loft.

Spine = Z (local frame +X front, +Y left, +Z up). The neck base is a short
column (Z ~3..63 mm). Reserved levels: self joint at Z=0 (parent mate, bottom)
and the neck_pitch child joint at Z=0.0374. connection_weight keeps both
interfaces exact while a uniform 0.88 radial slim makes the neck slender.

All slimmed axes stay inside the original bbox (radial scale < 1).
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
import numpy as np
import trimesh
from shapely.geometry import LineString
import paramlib as P
import connections as C

ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
SRC = f'{ROOT}/assets/profiles/asimov-1/meshes/NECK_YAW.STL'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/NECK_YAW.STL'

SLIM = 0.88  # slender neck


def _sample_ring(mesh, axis, lvl, angles, pdims):
    """Ray-cast one ring (centroid + radii) from the true mesh section at `lvl`.
    Same scheme as paramlib.slice_to_rings, used to anchor the mate plane exactly."""
    a = P.AXIS_IDX[axis]
    origin = np.zeros(3); origin[a] = lvl
    normal = np.zeros(3); normal[a] = 1.0
    sec = mesh.section(plane_origin=origin, plane_normal=normal)
    hull = P._section_polygon(sec, pdims)
    c = np.array(hull.centroid.coords[0])
    reach = max(hull.bounds[2] - hull.bounds[0], hull.bounds[3] - hull.bounds[1]) * 2 + 1e-3
    boundary = hull.boundary
    r = np.zeros(len(angles))
    for j, ang in enumerate(angles):
        d = np.array([np.cos(ang), np.sin(ang)])
        inter = LineString([tuple(c), tuple(c + d * reach)]).intersection(boundary)
        if inter.is_empty:
            continue
        if inter.geom_type == 'Point':
            pts = [np.array(inter.coords[0])]
        elif inter.geom_type in ('MultiPoint', 'GeometryCollection'):
            pts = [np.array(g.coords[0]) for g in inter.geoms if g.geom_type == 'Point']
        elif inter.geom_type == 'LineString':
            pts = [np.array(p) for p in inter.coords]
        else:
            pts = []
        if pts:
            r[j] = max(np.linalg.norm(p - c) for p in pts)
    return c, r


def _insert_anchor(param, mesh, lvl):
    """Insert a ring sampled at exactly `lvl` so the loft anchors that plane
    (used to pin the parent mate disc instead of cutting across a recess)."""
    c, r = _sample_ring(mesh, param.axis, lvl, param.angles, param.plane_dims)
    idx = np.searchsorted(param.levels, lvl)
    param.levels = np.insert(param.levels, idx, lvl)
    param.centroids = np.insert(param.centroids, idx, c, axis=0)
    param.radii = np.insert(param.radii, idx, r, axis=0)
    param.valid = np.insert(param.valid, idx, r.max() > 0)


def build():
    orig = trimesh.load(SRC)
    reserved = C.reserved_levels('NECK_YAW')  # [0.0, 0.03735]

    param = P.slice_to_rings(orig, axis='z', step=0.01, n_angular=72, pad=0.5)
    # Anchor the parent mate disc (Z=0) and a hair above so the loft's bottom
    # cap is the true 39 mm interface, not an interpolation across the keyway.
    _insert_anchor(param, orig, 0.0)
    _insert_anchor(param, orig, 0.001)
    w = P.connection_weight(param, reserved, ramp=0.03)

    # Uniform slim; connection_weight blends back to 1.0 at both joint planes.
    P.radial_scale(param, lambda z: SLIM, weight=w)

    rebuilt = P.rings_to_mesh(param)
    rebuilt.export(OUT)
    return orig, rebuilt, reserved


if __name__ == '__main__':
    orig, rebuilt, reserved = build()
    ob, rb = orig.bounds, rebuilt.bounds
    print('=== NECK_YAW femme ===  reserved', [round(r, 4) for r in reserved])
    for i, ax in enumerate('XYZ'):
        osp = (ob[1][i] - ob[0][i]) * 1000
        rsp = (rb[1][i] - rb[0][i]) * 1000
        print(f'  {ax}: orig={osp:6.1f}mm femme={rsp:6.1f}mm ratio={rsp / osp:.3f}')
    print(f'  watertight={rebuilt.is_watertight}')
