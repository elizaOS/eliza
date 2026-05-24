"""
Parametric mesh pipeline for ASIMOV-1 feminization.

A robot link mesh is reduced to a parametric "spine + cross-section rings"
representation, then warped, then lofted back to a clean watertight mesh.

Pipeline:
  1. slice_to_rings  — slice mesh perpendicular to a spine axis every `step` metres.
                       Each slice is angularly resampled to N rays from its centroid,
                       giving (level, centroid_2d, radii[N]) per ring.
  2. warp            — caller mutates levels / centroids / radii to feminize.
  3. rings_to_mesh   — loft consecutive rings into triangles, cap both ends.

Connection points (joint origins / child-joint attachment) are preserved by
NOT warping rings near the reserved Z-levels the caller declares.

Why spine+rings instead of vertex edits: cross-sections give a clean, dense,
ordered control lattice. Scaling a ring radius thins the limb uniformly; shifting
a centroid bends the spine (back arch); selectively scaling angular sectors adds
shape (hip flare forward/out) — all without tangling the triangle soup.
"""
import numpy as np
import trimesh
from shapely.geometry import Polygon, Point, LineString
from shapely.ops import unary_union

AXIS_IDX = {'x': 0, 'y': 1, 'z': 2}


class PartParam:
    """Parametric representation of one link mesh."""
    def __init__(self, axis, levels, centroids, radii, angles, valid):
        self.axis = axis               # spine axis 'x'|'y'|'z'
        self.levels = levels           # (K,) positions along spine axis (metres)
        self.centroids = centroids     # (K, 2) centroid in the two in-plane dims
        self.radii = radii             # (K, N) radius per fixed angle
        self.angles = angles           # (N,) fixed sample angles (radians)
        self.valid = valid             # (K,) bool: ring had a usable section

    @property
    def plane_dims(self):
        """The two in-plane dimension indices (everything except spine axis)."""
        a = AXIS_IDX[self.axis]
        return [d for d in range(3) if d != a]

    def copy(self):
        return PartParam(self.axis, self.levels.copy(), self.centroids.copy(),
                         self.radii.copy(), self.angles.copy(), self.valid.copy())


def _section_polygon(section, pdims):
    """Largest-area shapely Polygon from a Path3D section, in world in-plane
    coords (the two `pdims` dimensions). Uses ordered `.discrete` polylines."""
    best = None
    best_area = 0.0
    for pl in section.discrete:
        if len(pl) < 3:
            continue
        pts2d = pl[:, pdims]
        try:
            poly = Polygon(pts2d)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            if poly.geom_type == 'MultiPolygon':
                poly = max(poly.geoms, key=lambda p: p.area)
        except Exception:
            continue
        if poly.area > best_area:
            best_area = poly.area
            best = poly
    return best


def slice_to_rings(mesh, axis='z', step=0.01, n_angular=72, pad=0.5):
    """
    Slice `mesh` perpendicular to `axis` every `step` metres.
    Returns a PartParam.  Each ring is N angular radii measured from the
    section centroid (farthest boundary hit per ray → robust to concavity).
    """
    a = AXIS_IDX[axis]
    pdims = [d for d in range(3) if d != a]
    lo, hi = mesh.bounds[0][a], mesh.bounds[1][a]
    # Ring levels centred in each slab, leaving half-step margins
    levels = np.arange(lo + step * pad, hi, step)
    angles = np.linspace(0, 2 * np.pi, n_angular, endpoint=False)

    normal = np.zeros(3); normal[a] = 1.0
    K = len(levels)
    centroids = np.zeros((K, 2))
    radii = np.zeros((K, n_angular))
    valid = np.zeros(K, dtype=bool)

    for k, lvl in enumerate(levels):
        origin = np.zeros(3); origin[a] = lvl
        section = mesh.section(plane_origin=origin, plane_normal=normal)
        if section is None:
            continue
        hull = _section_polygon(section, pdims)
        if hull is None:
            continue

        c = np.array(hull.centroid.coords[0])
        centroids[k] = c
        # Cast rays from centroid, take farthest boundary intersection
        reach = max(hull.bounds[2] - hull.bounds[0], hull.bounds[3] - hull.bounds[1]) * 2 + 1e-3
        boundary = hull.boundary
        for j, ang in enumerate(angles):
            d = np.array([np.cos(ang), np.sin(ang)])
            far = c + d * reach
            ray = LineString([tuple(c), tuple(far)])
            inter = ray.intersection(boundary)
            if inter.is_empty:
                radii[k, j] = 0.0
                continue
            # farthest intersection point distance
            if inter.geom_type == 'Point':
                pts = [np.array(inter.coords[0])]
            elif inter.geom_type in ('MultiPoint', 'GeometryCollection'):
                pts = [np.array(g.coords[0]) for g in inter.geoms if g.geom_type == 'Point']
            elif inter.geom_type == 'LineString':
                pts = [np.array(p) for p in inter.coords]
            else:
                pts = []
            if not pts:
                radii[k, j] = 0.0
                continue
            radii[k, j] = max(np.linalg.norm(p - c) for p in pts)
        # Fill rays that missed (radius 0) by circular interpolation from
        # non-zero neighbours, so no angular point collapses onto the centroid.
        r = radii[k]
        miss = r <= 0
        if miss.any() and (~miss).sum() >= 2:
            good_idx = np.where(~miss)[0]
            ang = angles
            for j in np.where(miss)[0]:
                # nearest good neighbours on the circle
                prev = good_idx[good_idx < j]
                nxt = good_idx[good_idx > j]
                lo_i = prev[-1] if len(prev) else good_idx[-1]
                hi_i = nxt[0] if len(nxt) else good_idx[0]
                r[j] = 0.5 * (r[lo_i] + r[hi_i])
        valid[k] = r.max() > 0

    return PartParam(axis, levels, centroids, radii, angles, valid)


def _ring_point3d(param, k, j):
    """3D point of ring k angle j."""
    a = AXIS_IDX[param.axis]
    pdims = param.plane_dims
    p = np.zeros(3)
    p[a] = param.levels[k]
    ip = param.centroids[k] + param.radii[k, j] * np.array(
        [np.cos(param.angles[j]), np.sin(param.angles[j])])
    p[pdims[0]] = ip[0]
    p[pdims[1]] = ip[1]
    return p


def rings_to_mesh(param):
    """Loft valid rings into a watertight triangle mesh, capping both ends."""
    a = AXIS_IDX[param.axis]
    pdims = param.plane_dims
    N = len(param.angles)
    ks = [k for k in range(len(param.levels)) if param.valid[k]]
    if len(ks) < 2:
        raise ValueError("Not enough valid rings to loft")

    verts = []
    faces = []
    ring_start = {}
    for k in ks:
        ring_start[k] = len(verts)
        for j in range(N):
            verts.append(_ring_point3d(param, k, j))

    # Side walls between consecutive valid rings
    for ki in range(len(ks) - 1):
        k0, k1 = ks[ki], ks[ki + 1]
        s0, s1 = ring_start[k0], ring_start[k1]
        for j in range(N):
            jn = (j + 1) % N
            a0, b0 = s0 + j, s0 + jn
            a1, b1 = s1 + j, s1 + jn
            faces.append([a0, a1, b1])
            faces.append([a0, b1, b0])

    # Cap bottom (first ring) and top (last ring) with a centroid fan
    def cap(k, flip):
        s = ring_start[k]
        c3 = np.zeros(3); c3[a] = param.levels[k]
        c3[pdims[0]] = param.centroids[k][0]
        c3[pdims[1]] = param.centroids[k][1]
        ci = len(verts); verts.append(c3)
        for j in range(N):
            jn = (j + 1) % N
            if flip:
                faces.append([ci, s + jn, s + j])
            else:
                faces.append([ci, s + j, s + jn])

    cap(ks[0], flip=True)
    cap(ks[-1], flip=False)

    m = trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=True)
    # Merge coincident vertices, repair winding, orient outward.
    m.merge_vertices()
    trimesh.repair.fix_winding(m)
    trimesh.repair.fix_normals(m)
    if m.volume < 0:
        m.invert()
    return m


def reserved_mask(param, reserved_levels, protect_radius=0.012):
    """Bool mask of rings within protect_radius (m) of any reserved spine level.
    Reserved rings should not be warped so connection interfaces stay put."""
    mask = np.zeros(len(param.levels), dtype=bool)
    for rl in reserved_levels:
        mask |= np.abs(param.levels - rl) < protect_radius
    return mask


# ── Warp helpers ───────────────────────────────────────────────────────────
# All warps take a connection-taper weight in [0,1] per ring: 0 at a protected
# connection level (interface untouched), ramping to 1 away from it. This keeps
# joints mating exactly while the free body is reshaped.

def connection_weight(param, reserved_levels, ramp=0.03):
    """Per-ring weight: 0 at reserved connection levels, → 1 over `ramp` metres.
    Multiply any warp delta by this so interfaces stay put and blends are smooth."""
    z = param.levels
    if not reserved_levels:
        return np.ones(len(z))
    # distance to nearest reserved level
    d = np.min(np.abs(z[:, None] - np.array(reserved_levels)[None, :]), axis=1)
    w = np.clip(d / max(ramp, 1e-6), 0.0, 1.0)
    # smoothstep for C1 continuity
    return w * w * (3 - 2 * w)


def radial_scale(param, fn, weight=None):
    """Scale every ring's radii by fn(z) (uniform thinning/thickening).
    fn: callable(level)->scalar multiplier (1.0 = unchanged).
    Blended by `weight` (per-ring) toward 1.0 at connections."""
    if weight is None:
        weight = np.ones(len(param.levels))
    for k in range(len(param.levels)):
        s = fn(param.levels[k])
        eff = 1.0 + (s - 1.0) * weight[k]
        param.radii[k] *= eff
    return param


def axis_scale(param, dim, fn, weight=None):
    """Scale only one in-plane dimension (e.g. squash depth, widen hips).
    `dim` is a world axis index (0=x,1=y,2=z) and must be an in-plane dim.
    Applies to the angular radii by scaling their projection on that dim."""
    if weight is None:
        weight = np.ones(len(param.levels))
    pdims = param.plane_dims
    if dim not in pdims:
        raise ValueError("dim must be in-plane")
    local = pdims.index(dim)  # 0 or 1 within the in-plane frame
    comp = np.cos(param.angles) if local == 0 else np.sin(param.angles)
    other = np.sin(param.angles) if local == 0 else np.cos(param.angles)
    for k in range(len(param.levels)):
        s = fn(param.levels[k])
        eff = 1.0 + (s - 1.0) * weight[k]
        # x' = (eff*cos)·r ... rescale only the targeted component magnitude
        # recompute radius for the blended ellipse per angle
        rc = param.radii[k] * comp * eff
        ro = param.radii[k] * other
        param.radii[k] = np.hypot(rc, ro)
    return param


def spine_shift(param, fn, weight=None):
    """Bend the spine: shift each ring centroid by fn(z) -> (dp0, dp1) in the
    two in-plane dims (metres). Use for back arch, hip-set, posture."""
    if weight is None:
        weight = np.ones(len(param.levels))
    for k in range(len(param.levels)):
        d = np.asarray(fn(param.levels[k]), dtype=float)
        param.centroids[k] += d * weight[k]
    return param


def sector_scale(param, ang_center, ang_width, fn, weight=None):
    """Scale radii only within an angular sector [ang_center±ang_width/2].
    Use for directional shaping (push glutes back, chest forward).
    fn: callable(level)->multiplier for the sector."""
    if weight is None:
        weight = np.ones(len(param.levels))
    da = np.abs((param.angles - ang_center + np.pi) % (2 * np.pi) - np.pi)
    in_sector = da <= (ang_width / 2)
    # cosine falloff inside the sector for smooth blend
    falloff = np.where(in_sector, 0.5 * (1 + np.cos(np.pi * da / (ang_width / 2))), 0.0)
    for k in range(len(param.levels)):
        s = fn(param.levels[k])
        eff = 1.0 + (s - 1.0) * falloff * weight[k]
        param.radii[k] *= eff
    return param


def bbox_of(param):
    """Tight 3D bounding box of the current parametric rings (metres)."""
    a = AXIS_IDX[param.axis]
    pdims = param.plane_dims
    lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
    for k in range(len(param.levels)):
        if not param.valid[k]:
            continue
        lo[a] = min(lo[a], param.levels[k]); hi[a] = max(hi[a], param.levels[k])
        for j in range(len(param.angles)):
            ip = param.centroids[k] + param.radii[k, j] * np.array(
                [np.cos(param.angles[j]), np.sin(param.angles[j])])
            for i, d in enumerate(pdims):
                lo[d] = min(lo[d], ip[i]); hi[d] = max(hi[d], ip[i])
    return np.array([lo, hi])
