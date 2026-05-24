"""
Direct vertex warp for ASIMOV-1 feminization.

The loft pipeline (slice -> largest-polygon -> re-mesh) FRAGMENTS multi-component
mechanical parts: as the slice plane rises, the "largest" region jumps between
disconnected solids (actuator vs frame vs housing), so the reconstructed centroid
corkscrews and the loft tears into floating chunks. Watertight, but garbage.

This module instead WARPS THE ORIGINAL MESH IN PLACE:
  - keep every original vertex and face (topology, detail, watertightness preserved)
  - displace each vertex by a smooth field defined along a spine axis
  - field = radial scale s(z) about a smooth spine centreline, plus optional
    directional (sector) gain and centreline shift (arch)
  - field blends to identity near reserved connection levels so joints mate exactly

Because we never rebuild triangles, there is no fragmentation and no faceting
beyond the mesh's own resolution.
"""
import numpy as np
import trimesh

AXIS_IDX = {'x': 0, 'y': 1, 'z': 2}


def spine_centerline(mesh, axis='z', nbins=60, smooth=5):
    """Smooth centreline c(level) of the section centroids along `axis`.
    Returns (levels[nbins], center[nbins,2]) in the two in-plane dims.
    Uses per-bin vertex centroid (robust; no sectioning needed)."""
    a = AXIS_IDX[axis]
    pdims = [d for d in range(3) if d != a]
    v = mesh.vertices
    lo, hi = v[:, a].min(), v[:, a].max()
    edges = np.linspace(lo, hi, nbins + 1)
    centers = np.linspace(lo, hi, nbins)
    cen = np.zeros((nbins, 2))
    binidx = np.clip(np.digitize(v[:, a], edges) - 1, 0, nbins - 1)
    for b in range(nbins):
        sel = binidx == b
        if sel.any():
            cen[b] = v[sel][:, pdims].mean(axis=0)
        else:
            cen[b] = cen[b - 1] if b > 0 else 0.0
    # moving-average smooth
    if smooth > 1:
        k = np.ones(smooth) / smooth
        for d in range(2):
            cen[:, d] = np.convolve(np.pad(cen[:, d], smooth, mode='edge'), k, 'same')[smooth:-smooth]
    return centers, cen


def _interp_center(levels, centers, z):
    """Vectorised linear interpolation of the 2-D centreline at heights z."""
    out = np.zeros((len(z), 2))
    for d in range(2):
        out[:, d] = np.interp(z, levels, centers[:, d])
    return out


def connection_weight_z(z, reserved_levels, ramp=0.03):
    """Per-vertex weight in [0,1]: 0 at reserved connection levels, ->1 over ramp."""
    if not reserved_levels:
        return np.ones_like(z)
    d = np.min(np.abs(z[:, None] - np.asarray(reserved_levels)[None, :]), axis=1)
    w = np.clip(d / max(ramp, 1e-9), 0.0, 1.0)
    return w * w * (3 - 2 * w)


def warp(mesh, axis='z', radial=None, sectors=None, shift=None,
         reserved=None, ramp=0.03):
    """
    Return a copy of `mesh` with vertices warped. Faces unchanged.

    radial:  callable(z)->scalar multiplier for the whole cross-section (1=keep).
    sectors: list of dicts {center, width, gain} where gain is callable(z)->mult
             applied only within an angular sector about the spine (angle 0 = +pdim0).
    shift:   callable(z)->(d0,d1) centreline displacement in the in-plane dims (m).
    reserved: connection levels (along axis) to pin; warp blends to identity there.
    ramp:    metres over which the pin relaxes.
    """
    a = AXIS_IDX[axis]
    pdims = [d for d in range(3) if d != a]
    m = mesh.copy()
    v = m.vertices.copy()
    z = v[:, a]

    levels, centers = spine_centerline(mesh, axis=axis)
    c = _interp_center(levels, centers, z)              # (Nv,2)
    off = v[:, pdims] - c                                # offset from spine
    rad = np.linalg.norm(off, axis=1)
    ang = np.arctan2(off[:, 1], off[:, 0])

    w = connection_weight_z(z, reserved or [], ramp=ramp)

    # base radial scale
    if radial is not None:
        s = np.array([radial(zz) for zz in z])
        s = 1.0 + (s - 1.0) * w
    else:
        s = np.ones_like(z)

    # directional sector gains (multiply onto s per-vertex)
    if sectors:
        for spec in sectors:
            ctr = spec['center']; wid = spec['width']; gain = spec['gain']
            da = np.abs((ang - ctr + np.pi) % (2 * np.pi) - np.pi)
            inside = da <= (wid / 2)
            fall = np.where(inside, 0.5 * (1 + np.cos(np.pi * da / (wid / 2))), 0.0)
            g = np.array([gain(zz) for zz in z])
            s = s * (1.0 + (g - 1.0) * fall * w)

    new_off = off * s[:, None]

    # centreline shift (arch / posture)
    new_c = c.copy()
    if shift is not None:
        d = np.array([shift(zz) for zz in z])           # (Nv,2)
        new_c = c + d * w[:, None]

    newv = v.copy()
    newv[:, pdims] = new_c + new_off
    m.vertices = newv
    return m


def bbox_ratios(orig, warped):
    ob, wb = orig.bounds, warped.bounds
    return [ (wb[1][i]-wb[0][i])/(ob[1][i]-ob[0][i]) for i in range(3) ]
