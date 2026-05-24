"""
Constraint-based feminization warp (v2).

PRINCIPLE: the per-cross-section transform is a SIMILARITY transform
(uniform scale + translation) about the section's true outer-boundary center.
A similarity transform preserves angles, so anything round STAYS round — this is
the geometric constraint the user requires. No per-axis or per-sector squashing
of mechanical cross-sections (that is what turned circles into eggs before).

Constraints enforced:
  * Roundness: uniform scale only -> circles map to circles.
  * Connection interfaces: scale==1 and zero shift at reserved spine levels
    (locked), blended smoothly so mating rings are untouched.
  * Coaxial spine: scale is about a SMOOTH outer-boundary centreline, not a
    jittery vertex mean, so the part doesn't shear.

Topology is never rebuilt: we displace original vertices, so all mechanical
detail and watertightness state are preserved exactly.
"""
import numpy as np
import trimesh

AXIS_IDX = {'x': 0, 'y': 1, 'z': 2}


def outer_centerline(mesh, axis='z', step=0.005, smooth_m=9):
    """Smooth centreline from the OUTER (largest-area) section loop centroid at
    each station. Falls back to vertex centroid where sectioning fails.
    Returns (levels, centers[:,2]) in the two in-plane dims."""
    a = AXIS_IDX[axis]
    pd = [d for d in range(3) if d != a]
    lo, hi = mesh.bounds[0][a], mesh.bounds[1][a]
    levels = np.arange(lo + step * 0.5, hi, step)
    normal = np.zeros(3); normal[a] = 1.0
    cen = np.full((len(levels), 2), np.nan)
    for i, lvl in enumerate(levels):
        o = np.zeros(3); o[a] = lvl
        s = mesh.section(plane_origin=o, plane_normal=normal)
        if s is None:
            continue
        best = None; best_area = -1
        from shapely.geometry import Polygon
        for pl in s.discrete:
            if len(pl) < 3:
                continue
            try:
                poly = Polygon(pl[:, pd])
                if not poly.is_valid:
                    poly = poly.buffer(0)
                ar = poly.area
            except Exception:
                continue
            if ar > best_area:
                best_area = ar
                best = np.array(poly.centroid.coords[0]) if poly.geom_type == 'Polygon' \
                    else np.array(max(poly.geoms, key=lambda g: g.area).centroid.coords[0])
        if best is not None:
            cen[i] = best
    # fill nans by interpolation
    for d in range(2):
        col = cen[:, d]
        good = ~np.isnan(col)
        if good.sum() >= 2:
            cen[:, d] = np.interp(levels, levels[good], col[good])
        else:
            cen[:, d] = np.nanmean(col) if good.any() else 0.0
    # moving-average smooth
    if smooth_m > 1:
        k = np.ones(smooth_m) / smooth_m
        for d in range(2):
            cen[:, d] = np.convolve(np.pad(cen[:, d], smooth_m, mode='edge'), k, 'same')[smooth_m:-smooth_m]
    return levels, cen


def warp_affine(mesh, spine='z', factor=1.0, center=(0.0, 0.0)):
    """Constant anisotropic scale of the two NON-spine dims by `factor`, about
    `center` (default the joint axis at local origin), spine dim unchanged.

    This is the ONLY transform that keeps flat plates perfectly flat AND
    spine-axis bores perfectly round (constant affine maps planes->planes and
    equal-scaled circles->circles). Length along the spine is preserved, so the
    joint spacing — and the part's rotation axis — are unchanged.
    """
    a = AXIS_IDX[spine]
    pd = [d for d in range(3) if d != a]
    m = mesh.copy()
    v = m.vertices.copy()
    v[:, pd[0]] = center[0] + (v[:, pd[0]] - center[0]) * factor
    v[:, pd[1]] = center[1] + (v[:, pd[1]] - center[1]) * factor
    m.vertices = v
    return m


def connection_weight(z, reserved, ramp=0.025):
    if not reserved:
        return np.ones_like(z)
    dist = np.min(np.abs(z[:, None] - np.asarray(reserved)[None, :]), axis=1)
    w = np.clip(dist / max(ramp, 1e-9), 0, 1)
    return w * w * (3 - 2 * w)


def warp_similarity(mesh, axis='z', scale_fn=None, shift_fn=None,
                    reserved=None, ramp=0.025, step=0.005, smooth_m=9):
    """Uniform per-station similarity warp. scale_fn(z)->s (uniform, roundness-safe).
    shift_fn(z)->(d0,d1) optional centreline move (arch), also blended at joints."""
    a = AXIS_IDX[axis]
    pd = [d for d in range(3) if d != a]
    levels, centers = outer_centerline(mesh, axis=axis, step=step, smooth_m=smooth_m)

    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, a]
    c = np.empty((len(v), 2))
    c[:, 0] = np.interp(z, levels, centers[:, 0])
    c[:, 1] = np.interp(z, levels, centers[:, 1])

    w = connection_weight(z, reserved or [], ramp=ramp)
    s = np.ones_like(z)
    if scale_fn is not None:
        raw = np.array([scale_fn(zz) for zz in z])
        s = 1.0 + (raw - 1.0) * w           # uniform scale, locked at joints

    off = v[:, pd] - c                       # offset from section centre
    new_off = off * s[:, None]               # UNIFORM scale -> roundness preserved

    new_c = c.copy()
    if shift_fn is not None:
        d = np.array([shift_fn(zz) for zz in z])
        new_c = c + d * w[:, None]

    nv = v.copy()
    nv[:, pd] = new_c + new_off
    m.vertices = nv
    return m


def warp_profile(mesh, axis='z', scale_fn=None, bulges=None, shift_fn=None,
                 reserved=None, ramp=0.025, step=0.005, smooth_m=9):
    """
    Constrained PROFILE warp for the cosmetic body (torso/pelvis only).

    Combines:
      * scale_fn(z)->s        uniform cinch/slim (roundness-safe)
      * bulges: list of dicts {center, width, gain} where gain(z)->mult; pushes a
        smooth angular SECTOR outward (bust forward, hips out). Cosine falloff in
        the sector keeps the surface smooth. Directional by design — only used on
        the non-round cosmetic torso/pelvis, never on round mechanical limbs.
      * shift_fn(z)->(d0,d1)  centreline move (back arch)

    All effects blend to zero at reserved connection levels. Angle 0 = +pdim0
    (for a z-spine: +X = front). Sectors are measured about the section centre.
    """
    a = AXIS_IDX[axis]
    pd = [d for d in range(3) if d != a]
    levels, centers = outer_centerline(mesh, axis=axis, step=step, smooth_m=smooth_m)

    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, a]
    c = np.empty((len(v), 2))
    c[:, 0] = np.interp(z, levels, centers[:, 0])
    c[:, 1] = np.interp(z, levels, centers[:, 1])

    w = connection_weight(z, reserved or [], ramp=ramp)
    off = v[:, pd] - c
    rad = np.linalg.norm(off, axis=1)
    ang = np.arctan2(off[:, 1], off[:, 0])

    s = np.ones_like(z)
    if scale_fn is not None:
        raw = np.array([scale_fn(zz) for zz in z])
        s = 1.0 + (raw - 1.0) * w

    if bulges:
        for b in bulges:
            ctr = b['center']; wid = b['width']; gfn = b['gain']
            da = np.abs((ang - ctr + np.pi) % (2 * np.pi) - np.pi)
            inside = da <= (wid / 2)
            fall = np.where(inside, 0.5 * (1 + np.cos(np.pi * da / (wid / 2))), 0.0)
            g = np.array([gfn(zz) for zz in z])
            s = s * (1.0 + (g - 1.0) * fall * w)

    new_off = off * s[:, None]
    new_c = c.copy()
    if shift_fn is not None:
        d = np.array([shift_fn(zz) for zz in z])
        new_c = c + d * w[:, None]

    nv = v.copy()
    nv[:, pd] = new_c + new_off
    m.vertices = nv
    return m
