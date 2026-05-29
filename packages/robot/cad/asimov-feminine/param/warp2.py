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
from collections import defaultdict
import math

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


def separate_quantized_components(
    mesh,
    axis='z',
    epsilon=1e-5,
    merge_tolerance=1e-6,
    component_offset_aliases=None,
):
    """Separate closed components that only touch after proof vertex quantization.

    Some source STLs contain multiple watertight components that share exact
    edges. The proof topology merge then sees four incident faces on those
    edges. This nudges each already-closed face component in the non-spine plane
    by a tiny deterministic amount, preserving the visible surface while making
    the component contacts explicit gaps below geometric tolerances.
    """
    a = AXIS_IDX[axis]
    pd = [d for d in range(3) if d != a]
    out = mesh.copy()
    vertices = np.asarray(out.vertices).copy()
    faces = np.asarray(out.faces)
    if len(faces) == 0:
        return out

    vertex_ids = {}
    next_vertex_id = 0
    face_vertex_ids = []
    for face in faces:
        ids = []
        for vertex_index in face:
            key = tuple(
                np.round(vertices[int(vertex_index)] / merge_tolerance)
                .astype(np.int64)
                .tolist()
            )
            if key not in vertex_ids:
                vertex_ids[key] = next_vertex_id
                next_vertex_id += 1
            ids.append(vertex_ids[key])
        face_vertex_ids.append(tuple(ids))

    edges = defaultdict(list)
    for face_index, ids in enumerate(face_vertex_ids):
        for start, end in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            edges[tuple(sorted((start, end)))].append(face_index)

    adjacency = [[] for _ in range(len(faces))]
    nonmanifold_edges = 0
    for incident_faces in edges.values():
        if len(incident_faces) == 2:
            left, right = incident_faces
            adjacency[left].append(right)
            adjacency[right].append(left)
        elif len(incident_faces) > 2:
            nonmanifold_edges += 1
    if nonmanifold_edges == 0:
        return out

    component_id = np.full(len(faces), -1, dtype=np.int64)
    components = []
    for start in range(len(faces)):
        if component_id[start] >= 0:
            continue
        current_id = len(components)
        stack = [start]
        component_id[start] = current_id
        component_faces = []
        while stack:
            face_index = stack.pop()
            component_faces.append(face_index)
            for neighbor in adjacency[face_index]:
                if component_id[neighbor] < 0:
                    component_id[neighbor] = current_id
                    stack.append(neighbor)
        components.append(component_faces)
    if len(components) <= 1:
        return out

    centroids = np.array([
        vertices[faces[component_faces]].reshape(-1, 3).mean(axis=0)
        for component_faces in components
    ])
    global_centroid = centroids.mean(axis=0)
    offsets = []
    for index, centroid in enumerate(centroids):
        direction = centroid[pd] - global_centroid[pd]
        norm = float(np.linalg.norm(direction))
        if norm <= 1e-12:
            angle = 2.0 * math.pi * index / max(1, len(components))
            direction = np.array([math.cos(angle), math.sin(angle)])
        else:
            direction = direction / norm
        offset = np.zeros(3)
        offset[pd] = direction * epsilon
        offsets.append(offset)
    offsets = np.asarray(offsets)
    if component_offset_aliases:
        for child, parent in component_offset_aliases.items():
            if 0 <= child < len(offsets) and 0 <= parent < len(offsets):
                offsets[child] = offsets[parent]

    separated_vertices = vertices[faces].reshape(-1, 3).copy()
    separated_faces = np.arange(len(separated_vertices), dtype=np.int64).reshape(-1, 3)
    for face_index, face in enumerate(faces):
        separated_vertices[face_index * 3 : face_index * 3 + 3] += offsets[
            component_id[face_index]
        ]
    out = trimesh.Trimesh(
        vertices=separated_vertices,
        faces=separated_faces,
        process=False,
    )
    return out


def cap_quantized_boundary_loops(mesh, merge_tolerance=1e-6, max_loop_vertices=64):
    """Cap small boundary loops measured after proof vertex quantization."""
    vertices = np.asarray(mesh.vertices).copy()
    faces = np.asarray(mesh.faces).copy()
    if len(faces) == 0:
        return mesh.copy()

    vertex_ids = {}
    representative = []
    face_vertex_ids = []
    for face in faces:
        ids = []
        for vertex_index in face:
            key = tuple(
                np.round(vertices[int(vertex_index)] / merge_tolerance)
                .astype(np.int64)
                .tolist()
            )
            if key not in vertex_ids:
                vertex_ids[key] = len(representative)
                representative.append(int(vertex_index))
            ids.append(vertex_ids[key])
        face_vertex_ids.append(tuple(ids))

    edges = defaultdict(list)
    for face_index, ids in enumerate(face_vertex_ids):
        for start, end in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            edges[tuple(sorted((start, end)))].append(face_index)
    boundary_edges = [edge for edge, incident in edges.items() if len(incident) == 1]
    if not boundary_edges:
        return mesh.copy()

    adjacency = defaultdict(list)
    for start, end in boundary_edges:
        adjacency[start].append(end)
        adjacency[end].append(start)

    loops = []
    seen_edges = set()
    for start_edge in boundary_edges:
        edge_key = tuple(sorted(start_edge))
        if edge_key in seen_edges:
            continue
        start, current = start_edge
        previous = start
        loop = [start, current]
        seen_edges.add(edge_key)
        while current != start:
            candidates = [
                candidate
                for candidate in adjacency[current]
                if tuple(sorted((current, candidate))) not in seen_edges
            ]
            if not candidates:
                break
            next_vertex = candidates[0]
            seen_edges.add(tuple(sorted((current, next_vertex))))
            previous, current = current, next_vertex
            if current != start:
                loop.append(current)
        if current == start and 3 <= len(loop) <= max_loop_vertices:
            loops.append(loop)

    if not loops:
        return mesh.copy()

    new_vertices = vertices.tolist()
    new_faces = faces.tolist()
    for loop in loops:
        loop_indices = [representative[vertex_id] for vertex_id in loop]
        points = vertices[loop_indices]
        center_index = len(new_vertices)
        new_vertices.append(points.mean(axis=0).tolist())
        for index, vertex_index in enumerate(loop_indices):
            next_index = loop_indices[(index + 1) % len(loop_indices)]
            new_faces.append([vertex_index, next_index, center_index])

    return trimesh.Trimesh(
        vertices=np.asarray(new_vertices),
        faces=np.asarray(new_faces),
        process=False,
    )


def remove_excess_quantized_nonmanifold_faces(mesh, merge_tolerance=1e-6):
    """Drop extra faces from edges with more than two quantized incident faces.

    This is a narrow cleanup for source meshes with overlapping coplanar sheets:
    keep the first two incident faces on every quantized edge, then let boundary
    capping close the small holes left by removed duplicate sheet triangles.
    """
    vertices = np.asarray(mesh.vertices).copy()
    faces = np.asarray(mesh.faces).copy()
    if len(faces) == 0:
        return mesh.copy()

    vertex_ids = {}
    face_vertex_ids = []
    for face in faces:
        ids = []
        for vertex_index in face:
            key = tuple(
                np.round(vertices[int(vertex_index)] / merge_tolerance)
                .astype(np.int64)
                .tolist()
            )
            if key not in vertex_ids:
                vertex_ids[key] = len(vertex_ids)
            ids.append(vertex_ids[key])
        face_vertex_ids.append(tuple(ids))

    edges = defaultdict(list)
    for face_index, ids in enumerate(face_vertex_ids):
        for start, end in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            edges[tuple(sorted((start, end)))].append(face_index)

    remove = set()
    for incident_faces in edges.values():
        if len(incident_faces) > 2:
            remove.update(incident_faces[2:])
    if not remove:
        return mesh.copy()

    keep = [index for index in range(len(faces)) if index not in remove]
    return trimesh.Trimesh(
        vertices=vertices,
        faces=faces[keep],
        process=False,
    )
