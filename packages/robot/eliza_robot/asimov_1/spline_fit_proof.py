"""Pure-NumPy spline fit proofs for ASIMOV-1 mesh cross-sections."""

from __future__ import annotations

import json
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_MESH_DIR

AXIS_IDX = {"x": 0, "y": 1, "z": 2}
SECTION_METHODS = {
    "slab",
    "plane_intersection",
    "plane_intersection_with_slab_fallback",
    "plane_loops",
}
ROBOT_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
ASIMOV_FEMININE_CAD_ROOT = ROBOT_PACKAGE_ROOT / "cad" / "asimov-feminine"
ASIMOV_PARAM_ROOT = ASIMOV_FEMININE_CAD_ROOT / "param"
ASIMOV_PARAM_OUTPUT_STL = ASIMOV_FEMININE_CAD_ROOT / "output" / "stl"
ASIMOV_PARAM_PROOFS = ASIMOV_FEMININE_CAD_ROOT / "proofs"


@dataclass(frozen=True)
class RingSplineFit:
    level: float
    point_count: int
    control_count: int
    rms_error_m: float
    max_error_m: float
    rank: int
    ok: bool
    loop_index: int = 0
    loop_perimeter_m: float | None = None
    sampled_level: float | None = None
    level_nudge_m: float = 0.0


@dataclass(frozen=True)
class InterfacePreservation:
    level: float
    source_point_count: int
    output_point_count: int
    centroid_delta_m: float
    bbox_delta_m: float
    radius_delta_m: float
    ok: bool


@dataclass(frozen=True)
class MeshTopologyProof:
    triangle_count: int
    unique_vertex_count: int
    degenerate_faces: int
    boundary_edges: int
    nonmanifold_edges: int
    manifold_component_count: int
    largest_manifold_component_faces: int
    watertight: bool
    ok: bool


@dataclass(frozen=True)
class SurfaceDistanceProof:
    source_sample_count: int
    output_sample_count: int
    source_to_output_rms_m: float
    source_to_output_max_m: float
    output_to_source_rms_m: float
    output_to_source_max_m: float
    symmetric_chamfer_rms_m: float
    symmetric_hausdorff_m: float
    ok: bool


def read_binary_stl_triangles(path: Path) -> np.ndarray:
    """Read a binary STL into a `(triangle_count, 3, 3)` float64 array."""
    with path.open("rb") as fh:
        fh.read(80)
        tri_count = struct.unpack("<I", fh.read(4))[0]
        raw = np.frombuffer(fh.read(tri_count * 50), dtype=np.uint8).reshape(tri_count, 50)
    return raw[:, 12:48].view(np.float32).reshape(tri_count, 3, 3).astype(np.float64)


def read_binary_stl_vertices(path: Path) -> np.ndarray:
    """Read a binary STL into a flat `(N*3, 3)` float64 vertex array."""
    return read_binary_stl_triangles(path).reshape(-1, 3)


def load_reserved_levels(link: str) -> list[float]:
    """Load connection levels from the CAD param connection table without importing it."""
    connections_py = ASIMOV_PARAM_ROOT / "connections.py"
    if not connections_py.is_file():
        return [0.0]
    namespace: dict[str, Any] = {}
    exec(connections_py.read_text(encoding="utf-8"), namespace)
    reserved = namespace.get("reserved_levels")
    if not callable(reserved):
        return [0.0]
    try:
        return [float(level) for level in reserved(link)]
    except Exception:
        return [0.0]


def load_connection_specs() -> dict[str, dict[str, Any]]:
    """Load the expected ASIMOV link connection specs from the param workspace."""
    connections_py = ASIMOV_PARAM_ROOT / "connections.py"
    if not connections_py.is_file():
        return {}
    namespace: dict[str, Any] = {}
    exec(connections_py.read_text(encoding="utf-8"), namespace)
    links = namespace.get("LINKS", {})
    if not isinstance(links, dict):
        return {}
    return {str(name): dict(spec) for name, spec in sorted(links.items())}


def _periodic_cubic_basis(sample_count: int, control_count: int) -> np.ndarray:
    """Uniform periodic cubic B-spline basis at evenly spaced angular samples."""
    if control_count < 4:
        raise ValueError("control_count must be >= 4")
    t = np.arange(sample_count, dtype=np.float64) * control_count / sample_count
    base = np.floor(t).astype(int)
    u = t - base
    weights = np.column_stack(
        [
            ((1 - u) ** 3) / 6.0,
            (3 * u**3 - 6 * u**2 + 4) / 6.0,
            (-3 * u**3 + 3 * u**2 + 3 * u + 1) / 6.0,
            (u**3) / 6.0,
        ]
    )
    basis = np.zeros((sample_count, control_count), dtype=np.float64)
    for sample_idx in range(sample_count):
        for offset in range(4):
            basis[sample_idx, (base[sample_idx] + offset - 1) % control_count] += weights[
                sample_idx, offset
            ]
    return basis


def _fit_periodic_cubic(
    points_2d: np.ndarray,
    control_count: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    basis = _periodic_cubic_basis(len(points_2d), control_count)
    controls_x, residuals_x, rank_x, _ = np.linalg.lstsq(basis, points_2d[:, 0], rcond=None)
    controls_y, residuals_y, rank_y, _ = np.linalg.lstsq(basis, points_2d[:, 1], rcond=None)
    controls = np.column_stack([controls_x, controls_y])
    fitted = basis @ controls
    err = np.linalg.norm(fitted - points_2d, axis=1)
    return fitted, {
        "rms_error_m": float(np.sqrt(np.mean(err**2))),
        "max_error_m": float(err.max(initial=0.0)),
        "rank": int(min(rank_x, rank_y)),
        "residuals": [float(residuals_x.sum(initial=0.0)), float(residuals_y.sum(initial=0.0))],
    }


def _radial_ring_from_points(
    pts: np.ndarray,
    *,
    angular_samples: int,
    min_points: int,
) -> np.ndarray | None:
    if len(pts) < min_points:
        return None
    centroid = pts.mean(axis=0)
    offsets = pts - centroid
    radii = np.linalg.norm(offsets, axis=1)
    good = radii > 1e-9
    if int(good.sum()) < min_points:
        return None
    offsets = offsets[good]
    radii = radii[good]
    angles = (np.arctan2(offsets[:, 1], offsets[:, 0]) + 2 * np.pi) % (2 * np.pi)
    bins = np.floor(angles / (2 * np.pi) * angular_samples).astype(int).clip(0, angular_samples - 1)
    ring_radii = np.full(angular_samples, np.nan, dtype=np.float64)
    for idx, radius in zip(bins, radii, strict=False):
        if np.isnan(ring_radii[idx]) or radius > ring_radii[idx]:
            ring_radii[idx] = radius
    valid = np.where(~np.isnan(ring_radii))[0]
    if len(valid) < max(8, angular_samples // 4):
        return None
    if len(valid) < angular_samples:
        x = np.arange(angular_samples)
        ring_radii = np.interp(
            x,
            np.r_[valid, valid[0] + angular_samples],
            np.r_[ring_radii[valid], ring_radii[valid[0]]],
        )
    sample_angles = np.linspace(0.0, 2 * np.pi, angular_samples, endpoint=False)
    return centroid + ring_radii[:, None] * np.column_stack(
        [np.cos(sample_angles), np.sin(sample_angles)]
    )


def _ring_points_from_slab(
    vertices: np.ndarray,
    *,
    axis: str,
    level: float,
    slab_half_width: float,
    angular_samples: int,
    min_points: int,
) -> np.ndarray | None:
    axis_idx = AXIS_IDX[axis]
    plane_dims = [dim for dim in range(3) if dim != axis_idx]
    slab = vertices[np.abs(vertices[:, axis_idx] - level) <= slab_half_width]
    return _radial_ring_from_points(
        slab[:, plane_dims],
        angular_samples=angular_samples,
        min_points=min_points,
    )


def _section_points_from_plane_intersections(
    triangles: np.ndarray,
    *,
    axis: str,
    level: float,
    dedupe_decimals: int = 8,
) -> np.ndarray:
    axis_idx = AXIS_IDX[axis]
    plane_dims = [dim for dim in range(3) if dim != axis_idx]
    values = triangles[:, :, axis_idx] - level
    points: list[np.ndarray] = []
    for triangle, distances in zip(triangles, values, strict=False):
        local: list[np.ndarray] = []
        for start, end in ((0, 1), (1, 2), (2, 0)):
            d0 = distances[start]
            d1 = distances[end]
            if (d0 < 0.0 and d1 > 0.0) or (d0 > 0.0 and d1 < 0.0):
                weight = abs(d0) / (abs(d0) + abs(d1))
                local.append(triangle[start] + (triangle[end] - triangle[start]) * weight)
            elif abs(d0) < 1e-9 and abs(d1) >= 1e-9:
                local.append(triangle[start])
        if len(local) >= 2:
            points.extend(local[:2])
    if not points:
        return np.empty((0, 2), dtype=np.float64)
    section = np.asarray(points, dtype=np.float64)[:, plane_dims]
    return np.unique(np.round(section, dedupe_decimals), axis=0)


def _plane_intersection_segments(
    triangles: np.ndarray,
    *,
    axis: str,
    level: float,
) -> list[tuple[np.ndarray, np.ndarray]]:
    axis_idx = AXIS_IDX[axis]
    plane_dims = [dim for dim in range(3) if dim != axis_idx]
    values = triangles[:, :, axis_idx] - level
    segments: list[tuple[np.ndarray, np.ndarray]] = []
    for triangle, distances in zip(triangles, values, strict=False):
        local: list[np.ndarray] = []
        for start, end in ((0, 1), (1, 2), (2, 0)):
            d0 = distances[start]
            d1 = distances[end]
            if (d0 < 0.0 and d1 > 0.0) or (d0 > 0.0 and d1 < 0.0):
                weight = abs(d0) / (abs(d0) + abs(d1))
                local.append(triangle[start] + (triangle[end] - triangle[start]) * weight)
            elif abs(d0) < 1e-9 and abs(d1) >= 1e-9:
                local.append(triangle[start])
        if len(local) >= 2:
            start = np.asarray(local[0], dtype=np.float64)[plane_dims]
            end = np.asarray(local[1], dtype=np.float64)[plane_dims]
            if np.linalg.norm(start - end) > 1e-9:
                segments.append((start, end))
    return segments


def _ring_points_from_plane_intersections(
    triangles: np.ndarray,
    *,
    axis: str,
    level: float,
    angular_samples: int,
    min_points: int,
) -> np.ndarray | None:
    return _radial_ring_from_points(
        _section_points_from_plane_intersections(triangles, axis=axis, level=level),
        angular_samples=angular_samples,
        min_points=min_points,
    )


def _closed_loops_from_plane_intersections(
    triangles: np.ndarray,
    *,
    axis: str,
    level: float,
    min_perimeter_m: float,
    dedupe_scale: float = 1e7,
) -> list[np.ndarray]:
    segments = _plane_intersection_segments(triangles, axis=axis, level=level)
    point_by_key: dict[tuple[int, int], np.ndarray] = {}
    adjacency: dict[tuple[int, int], list[tuple[tuple[int, int], int]]] = {}

    def point_key(point: np.ndarray) -> tuple[int, int]:
        values = np.round(point * dedupe_scale).astype(int)
        return int(values[0]), int(values[1])

    for segment_index, (start, end) in enumerate(segments):
        start_key = point_key(start)
        end_key = point_key(end)
        point_by_key.setdefault(start_key, start)
        point_by_key.setdefault(end_key, end)
        adjacency.setdefault(start_key, []).append((end_key, segment_index))
        adjacency.setdefault(end_key, []).append((start_key, segment_index))

    visited_segments: set[int] = set()
    loops: list[np.ndarray] = []
    for start_key in list(adjacency):
        for _, first_segment in adjacency[start_key]:
            if first_segment in visited_segments:
                continue
            sequence = [start_key]
            current_key = start_key
            previous_key: tuple[int, int] | None = None
            while True:
                candidates = [
                    (next_key, segment_index)
                    for next_key, segment_index in adjacency[current_key]
                    if segment_index not in visited_segments
                ]
                if not candidates:
                    break
                if previous_key is not None and len(candidates) > 1:
                    candidates = [
                        candidate for candidate in candidates if candidate[0] != previous_key
                    ] or candidates
                next_key, segment_index = candidates[0]
                visited_segments.add(segment_index)
                previous_key = current_key
                current_key = next_key
                sequence.append(current_key)
                if current_key == sequence[0]:
                    break
            if len(sequence) <= 3 or sequence[-1] != sequence[0]:
                continue
            loop = np.asarray([point_by_key[key] for key in sequence[:-1]], dtype=np.float64)
            closed = np.vstack([loop, loop[:1]])
            perimeter = float(np.linalg.norm(np.diff(closed, axis=0), axis=1).sum())
            if perimeter >= min_perimeter_m:
                loops.append(loop)
    loops.sort(
        key=lambda loop: -float(
            np.linalg.norm(np.diff(np.vstack([loop, loop[:1]]), axis=0), axis=1).sum()
        )
    )
    return loops


def _resample_closed_loop(loop: np.ndarray, sample_count: int) -> tuple[np.ndarray, float]:
    closed = np.vstack([loop, loop[:1]])
    distances = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(closed, axis=0), axis=1))]
    perimeter = float(distances[-1])
    if perimeter <= 0.0:
        return np.empty((0, 2), dtype=np.float64), 0.0
    samples = np.linspace(0.0, perimeter, sample_count, endpoint=False)
    return (
        np.column_stack(
            [
                np.interp(samples, distances, closed[:, 0]),
                np.interp(samples, distances, closed[:, 1]),
            ]
        ),
        perimeter,
    )


def _interface_profile(
    vertices: np.ndarray,
    *,
    axis: str,
    level: float,
    slab_half_width: float,
    min_points: int,
) -> dict[str, Any] | None:
    axis_idx = AXIS_IDX[axis]
    plane_dims = [dim for dim in range(3) if dim != axis_idx]
    slab = vertices[np.abs(vertices[:, axis_idx] - level) <= slab_half_width]
    if len(slab) < min_points:
        return None
    pts = slab[:, plane_dims]
    centroid = pts.mean(axis=0)
    bbox_min = pts.min(axis=0)
    bbox_max = pts.max(axis=0)
    radius = float(np.linalg.norm(pts - centroid, axis=1).max(initial=0.0))
    return {
        "point_count": int(len(pts)),
        "centroid": centroid,
        "bbox": np.array([bbox_min, bbox_max]),
        "radius": radius,
    }


def _prove_interfaces(
    source_vertices: np.ndarray,
    output_vertices: np.ndarray,
    *,
    axis: str,
    levels: list[float],
    slab_half_width: float,
    tolerance_m: float,
    min_points: int,
) -> list[InterfacePreservation]:
    proofs: list[InterfacePreservation] = []
    for level in levels:
        source = _interface_profile(
            source_vertices,
            axis=axis,
            level=level,
            slab_half_width=slab_half_width,
            min_points=min_points,
        )
        output = _interface_profile(
            output_vertices,
            axis=axis,
            level=level,
            slab_half_width=slab_half_width,
            min_points=min_points,
        )
        if source is None or output is None:
            proofs.append(
                InterfacePreservation(
                    level=float(level),
                    source_point_count=int(source["point_count"]) if source else 0,
                    output_point_count=int(output["point_count"]) if output else 0,
                    centroid_delta_m=float("inf"),
                    bbox_delta_m=float("inf"),
                    radius_delta_m=float("inf"),
                    ok=False,
                )
            )
            continue
        centroid_delta = float(np.linalg.norm(source["centroid"] - output["centroid"]))
        bbox_delta = float(np.max(np.abs(source["bbox"] - output["bbox"])))
        radius_delta = float(abs(source["radius"] - output["radius"]))
        proofs.append(
            InterfacePreservation(
                level=float(level),
                source_point_count=int(source["point_count"]),
                output_point_count=int(output["point_count"]),
                centroid_delta_m=centroid_delta,
                bbox_delta_m=bbox_delta,
                radius_delta_m=radius_delta,
                ok=bool(
                    centroid_delta <= tolerance_m
                    and bbox_delta <= tolerance_m
                    and radius_delta <= tolerance_m
                ),
            )
        )
    return proofs


def _prove_topology(triangles: np.ndarray, *, merge_tolerance_m: float) -> MeshTopologyProof:
    edges: dict[tuple[int, int], int] = {}
    vertex_ids: dict[tuple[int, int, int], int] = {}
    next_vertex_id = 0
    degenerate = 0
    face_edges: list[list[tuple[int, int]]] = []
    for tri in triangles:
        e1 = tri[1] - tri[0]
        e2 = tri[2] - tri[0]
        if float(np.linalg.norm(np.cross(e1, e2))) <= 1e-14:
            degenerate += 1
        ids: list[int] = []
        for vertex in tri:
            key = tuple(np.round(vertex / merge_tolerance_m).astype(np.int64).tolist())
            if key not in vertex_ids:
                vertex_ids[key] = next_vertex_id
                next_vertex_id += 1
            ids.append(vertex_ids[key])
        current_face_edges: list[tuple[int, int]] = []
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            edge = (a, b) if a < b else (b, a)
            edges[edge] = edges.get(edge, 0) + 1
            current_face_edges.append(edge)
        face_edges.append(current_face_edges)
    boundary = sum(1 for count in edges.values() if count == 1)
    nonmanifold = sum(1 for count in edges.values() if count > 2)
    incident_faces: dict[tuple[int, int], list[int]] = {}
    for face_idx, current_face_edges in enumerate(face_edges):
        for edge in current_face_edges:
            incident_faces.setdefault(edge, []).append(face_idx)
    adjacency: list[list[int]] = [[] for _ in range(len(face_edges))]
    for faces in incident_faces.values():
        if len(faces) == 2:
            a, b = faces
            adjacency[a].append(b)
            adjacency[b].append(a)
    component_count = 0
    largest_component = 0
    seen = np.zeros(len(face_edges), dtype=bool)
    for start in range(len(face_edges)):
        if seen[start]:
            continue
        component_count += 1
        stack = [start]
        seen[start] = True
        size = 0
        while stack:
            face = stack.pop()
            size += 1
            for neighbor in adjacency[face]:
                if not seen[neighbor]:
                    seen[neighbor] = True
                    stack.append(neighbor)
        largest_component = max(largest_component, size)
    watertight = boundary == 0 and nonmanifold == 0 and degenerate == 0
    return MeshTopologyProof(
        triangle_count=int(len(triangles)),
        unique_vertex_count=int(len(vertex_ids)),
        degenerate_faces=int(degenerate),
        boundary_edges=int(boundary),
        nonmanifold_edges=int(nonmanifold),
        manifold_component_count=int(component_count),
        largest_manifold_component_faces=int(largest_component),
        watertight=bool(watertight),
        ok=bool(watertight),
    )


def _sample_vertices(vertices: np.ndarray, max_count: int) -> np.ndarray:
    if len(vertices) <= max_count:
        return vertices
    idx = np.linspace(0, len(vertices) - 1, max_count, dtype=np.int64)
    return vertices[idx]


def _nearest_distances(a: np.ndarray, b: np.ndarray, *, chunk_size: int = 256) -> np.ndarray:
    distances = np.empty(len(a), dtype=np.float64)
    for start in range(0, len(a), chunk_size):
        chunk = a[start : start + chunk_size]
        diff = chunk[:, None, :] - b[None, :, :]
        distances[start : start + len(chunk)] = np.sqrt(np.min(np.sum(diff * diff, axis=2), axis=1))
    return distances


def _prove_surface_distance(
    source_vertices: np.ndarray,
    output_vertices: np.ndarray,
    *,
    max_sample_count: int,
    tolerance_m: float,
) -> SurfaceDistanceProof:
    source_sample = _sample_vertices(source_vertices, max_sample_count)
    output_sample = _sample_vertices(output_vertices, max_sample_count)
    source_to_output = _nearest_distances(source_sample, output_sample)
    output_to_source = _nearest_distances(output_sample, source_sample)
    source_rms = float(np.sqrt(np.mean(source_to_output**2)))
    output_rms = float(np.sqrt(np.mean(output_to_source**2)))
    source_max = float(source_to_output.max(initial=0.0))
    output_max = float(output_to_source.max(initial=0.0))
    chamfer = float(np.sqrt((source_rms**2 + output_rms**2) / 2.0))
    hausdorff = float(max(source_max, output_max))
    return SurfaceDistanceProof(
        source_sample_count=int(len(source_sample)),
        output_sample_count=int(len(output_sample)),
        source_to_output_rms_m=source_rms,
        source_to_output_max_m=source_max,
        output_to_source_rms_m=output_rms,
        output_to_source_max_m=output_max,
        symmetric_chamfer_rms_m=chamfer,
        symmetric_hausdorff_m=hausdorff,
        ok=bool(hausdorff <= tolerance_m),
    )


def _failure_reasons(
    *,
    rings: list[RingSplineFit],
    interface_proofs: list[InterfacePreservation],
    topology: MeshTopologyProof | None,
    surface_distance: SurfaceDistanceProof | None,
    max_error_m: float,
    rms_error_m: float,
    surface_distance_tolerance_m: float,
) -> list[str]:
    reasons: list[str] = []
    failed_rings = [ring for ring in rings if not ring.ok]
    if not rings:
        reasons.append("spline_fit:no_rings_fit")
    elif failed_rings:
        max_ring_error = max((ring.max_error_m for ring in failed_rings), default=float("inf"))
        max_ring_rms = max((ring.rms_error_m for ring in failed_rings), default=float("inf"))
        reasons.append(
            "spline_fit:"
            f"{len(failed_rings)}_rings_over_tolerance,"
            f"max={max_ring_error:.6g}>{max_error_m:.6g},"
            f"rms={max_ring_rms:.6g}>{rms_error_m:.6g}"
        )
    failed_interfaces = [proof for proof in interface_proofs if not proof.ok]
    if not interface_proofs:
        reasons.append("interface:no_connection_levels_checked")
    elif failed_interfaces:
        reasons.append(f"interface:{len(failed_interfaces)}_levels_over_tolerance")
    if topology is None:
        reasons.append("topology:no_output_mesh")
    elif not topology.ok:
        reasons.append(
            "topology:"
            f"boundary={topology.boundary_edges},"
            f"nonmanifold={topology.nonmanifold_edges},"
            f"degenerate={topology.degenerate_faces}"
        )
    if surface_distance is None:
        reasons.append("surface_distance:no_output_mesh")
    elif not surface_distance.ok:
        reasons.append(
            "surface_distance:"
            f"hausdorff={surface_distance.symmetric_hausdorff_m:.6g}"
            f">{surface_distance_tolerance_m:.6g}"
        )
    return reasons


def build_spline_fit_proof(
    *,
    link: str,
    mesh_path: Path | None = None,
    output_mesh_path: Path | None = None,
    axis: str = "z",
    step_m: float = 0.01,
    slab_m: float = 0.004,
    angular_samples: int = 96,
    control_count: int = 32,
    max_error_m: float = 0.003,
    rms_error_m: float = 0.001,
    interface_tolerance_m: float = 0.003,
    surface_distance_tolerance_m: float = 0.02,
    topology_merge_tolerance_m: float = 1e-6,
    surface_distance_samples: int = 5000,
    connection_levels: list[float] | None = None,
    min_points_per_ring: int = 24,
    section_method: str = "slab",
    min_loop_perimeter_m: float = 0.005,
    section_nudge_m: float = 1e-7,
) -> dict[str, Any]:
    """Fit and validate one closed cubic spline per mesh cross-section ring."""
    if section_method not in SECTION_METHODS:
        raise ValueError(f"section_method must be one of {sorted(SECTION_METHODS)}")
    max_control_to_sample_ratio = 2.0 / 3.0
    if control_count * 3 > angular_samples * 2:
        raise ValueError(
            "control_count must be no more than two thirds of angular_samples "
            "to avoid overfitted spline proofs"
        )
    if mesh_path is None:
        mesh_path = ASIMOV1_SOURCE_MESH_DIR / f"{link}.STL"
    if output_mesh_path is None:
        output_mesh_path = ASIMOV_PARAM_OUTPUT_STL / f"{link}.STL"
    source_triangles = read_binary_stl_triangles(mesh_path)
    output_triangles = (
        read_binary_stl_triangles(output_mesh_path) if output_mesh_path.is_file() else None
    )
    vertices = source_triangles.reshape(-1, 3)
    output_vertices = output_triangles.reshape(-1, 3) if output_triangles is not None else None
    axis_idx = AXIS_IDX[axis]
    lo = float(vertices[:, axis_idx].min())
    hi = float(vertices[:, axis_idx].max())
    levels = np.arange(lo + step_m * 0.5, hi, step_m, dtype=np.float64)
    rings: list[RingSplineFit] = []
    skipped_levels: list[float] = []
    fitted_levels: list[float] = []
    nudged_levels: list[float] = []
    for level in levels:
        level_rings: list[tuple[np.ndarray, int, float | None, float, float]] = []
        if section_method == "plane_loops":
            loops = []
            sampled_level = float(level)
            level_nudge = 0.0
            for nudge in (0.0, section_nudge_m, -section_nudge_m):
                loops = _closed_loops_from_plane_intersections(
                    source_triangles,
                    axis=axis,
                    level=float(level + nudge),
                    min_perimeter_m=min_loop_perimeter_m,
                )
                if loops:
                    sampled_level = float(level + nudge)
                    level_nudge = float(nudge)
                    break
            if level_nudge:
                nudged_levels.append(float(level))
            for loop_index, loop in enumerate(loops):
                ring, perimeter = _resample_closed_loop(loop, angular_samples)
                if len(ring) >= min_points_per_ring:
                    level_rings.append((ring, loop_index, perimeter, sampled_level, level_nudge))
        else:
            if section_method == "slab":
                ring = _ring_points_from_slab(
                    vertices,
                    axis=axis,
                    level=float(level),
                    slab_half_width=slab_m * 0.5,
                    angular_samples=angular_samples,
                    min_points=min_points_per_ring,
                )
            else:
                ring = _ring_points_from_plane_intersections(
                    source_triangles,
                    axis=axis,
                    level=float(level),
                    angular_samples=angular_samples,
                    min_points=min_points_per_ring,
                )
                if section_method == "plane_intersection_with_slab_fallback" and ring is None:
                    ring = _ring_points_from_slab(
                        vertices,
                        axis=axis,
                        level=float(level),
                        slab_half_width=slab_m * 0.5,
                        angular_samples=angular_samples,
                        min_points=min_points_per_ring,
                    )
            if ring is not None:
                level_rings.append((ring, 0, None, float(level), 0.0))
        if not level_rings:
            skipped_levels.append(float(level))
            continue
        fitted_levels.append(float(level))
        for ring, loop_index, loop_perimeter_m, sampled_level, level_nudge in level_rings:
            _, metrics = _fit_periodic_cubic(ring, control_count)
            ok = metrics["max_error_m"] <= max_error_m and metrics["rms_error_m"] <= rms_error_m
            rings.append(
                RingSplineFit(
                    level=float(level),
                    point_count=int(len(ring)),
                    control_count=int(control_count),
                    rms_error_m=metrics["rms_error_m"],
                    max_error_m=metrics["max_error_m"],
                    rank=metrics["rank"],
                    ok=bool(ok),
                    loop_index=int(loop_index),
                    loop_perimeter_m=loop_perimeter_m,
                    sampled_level=float(sampled_level),
                    level_nudge_m=float(level_nudge),
                )
            )

    ring_dicts = [asdict(ring) for ring in rings]
    max_observed = max((ring.max_error_m for ring in rings), default=float("inf"))
    rms_observed = max((ring.rms_error_m for ring in rings), default=float("inf"))
    levels_to_check = load_reserved_levels(link) if connection_levels is None else connection_levels
    interface_proofs = (
        _prove_interfaces(
            vertices,
            output_vertices,
            axis=axis,
            levels=levels_to_check,
            slab_half_width=max(slab_m, step_m * 0.5),
            tolerance_m=interface_tolerance_m,
            min_points=min_points_per_ring,
        )
        if output_vertices is not None
        else []
    )
    interface_dicts = [asdict(proof) for proof in interface_proofs]
    interface_ok = bool(interface_proofs) and all(proof.ok for proof in interface_proofs)
    source_topology = _prove_topology(
        source_triangles,
        merge_tolerance_m=topology_merge_tolerance_m,
    )
    topology = (
        _prove_topology(output_triangles, merge_tolerance_m=topology_merge_tolerance_m)
        if output_triangles is not None
        else None
    )
    surface_distance = (
        _prove_surface_distance(
            vertices,
            output_vertices,
            max_sample_count=surface_distance_samples,
            tolerance_m=surface_distance_tolerance_m,
        )
        if output_vertices is not None
        else None
    )
    topology_ok = bool(topology and topology.ok)
    surface_distance_ok = bool(surface_distance and surface_distance.ok)
    if fitted_levels:
        fit_lo = min(fitted_levels)
        fit_hi = max(fitted_levels)
        internal_skipped_levels = [
            level for level in skipped_levels if fit_lo < level < fit_hi
        ]
    else:
        internal_skipped_levels = skipped_levels
    all_sampled_levels = fitted_levels + skipped_levels
    fitted_span_m = (
        float(max(fitted_levels) - min(fitted_levels)) if len(fitted_levels) > 1 else 0.0
    )
    sampled_span_m = (
        float(max(all_sampled_levels) - min(all_sampled_levels))
        if len(all_sampled_levels) > 1
        else 0.0
    )
    section_span_ratio = fitted_span_m / sampled_span_m if sampled_span_m > 0.0 else 0.0
    min_section_span_ratio = 1.0 / 3.0
    section_coverage_ok = (
        len(internal_skipped_levels) == 0
        and section_span_ratio + 1e-12 >= min_section_span_ratio
    )
    ok = (
        bool(rings)
        and all(ring.ok for ring in rings)
        and section_coverage_ok
        and interface_ok
        and topology_ok
        and surface_distance_ok
    )
    failure_reasons = _failure_reasons(
        rings=rings,
        interface_proofs=interface_proofs,
        topology=topology,
        surface_distance=surface_distance,
        max_error_m=max_error_m,
        rms_error_m=rms_error_m,
        surface_distance_tolerance_m=surface_distance_tolerance_m,
    )
    if internal_skipped_levels:
        failure_reasons.append(f"section_coverage:{len(internal_skipped_levels)}_internal_skips")
    if section_span_ratio + 1e-12 < min_section_span_ratio:
        failure_reasons.append(
            "section_coverage:"
            f"span_ratio={section_span_ratio:.6g}<{min_section_span_ratio:.6g}"
        )
    report = {
        "schema": "asimov-1-spline-fit-proof-v1",
        "link": link,
        "mesh_path": str(mesh_path),
        "mesh_sha256": sha256_file(mesh_path),
        "mesh_bytes": int(mesh_path.stat().st_size),
        "output_mesh_path": str(output_mesh_path),
        "output_mesh_sha256": (
            sha256_file(output_mesh_path) if output_mesh_path.is_file() else None
        ),
        "output_mesh_bytes": (
            int(output_mesh_path.stat().st_size) if output_mesh_path.is_file() else None
        ),
        "axis": axis,
        "section_method": section_method,
        "step_m": float(step_m),
        "slab_m": float(slab_m),
        "angular_samples": int(angular_samples),
        "control_count": int(control_count),
        "fit_policy": {
            "control_sample_ratio": float(control_count / angular_samples),
            "max_control_sample_ratio": float(max_control_to_sample_ratio),
            "overfit_guard": "control_count <= floor(angular_samples * 2 / 3)",
        },
        "tolerances": {
            "max_error_m": float(max_error_m),
            "rms_error_m": float(rms_error_m),
            "interface_tolerance_m": float(interface_tolerance_m),
            "surface_distance_tolerance_m": float(surface_distance_tolerance_m),
            "topology_merge_tolerance_m": float(topology_merge_tolerance_m),
            "min_loop_perimeter_m": float(min_loop_perimeter_m),
            "section_nudge_m": float(section_nudge_m),
        },
        "summary": {
            "ok": ok,
            "failure_reasons": failure_reasons,
            "section_coverage_ok": bool(section_coverage_ok),
            "section_span_ratio": float(section_span_ratio),
            "min_section_span_ratio": float(min_section_span_ratio),
            "fitted_span_m": float(fitted_span_m),
            "sampled_span_m": float(sampled_span_m),
            "levels_checked": int(len(levels)),
            "rings_fit": len(rings),
            "rings_skipped": int(len(skipped_levels)),
            "internal_rings_skipped": int(len(internal_skipped_levels)),
            "nudged_levels": int(len(nudged_levels)),
            "max_error_m": float(max_observed),
            "max_rms_error_m": float(rms_observed),
            "interfaces_checked": len(interface_proofs),
            "interfaces_ok": int(sum(1 for proof in interface_proofs if proof.ok)),
            "max_interface_centroid_delta_m": float(
                max((proof.centroid_delta_m for proof in interface_proofs), default=float("inf"))
            ),
            "max_interface_bbox_delta_m": float(
                max((proof.bbox_delta_m for proof in interface_proofs), default=float("inf"))
            ),
            "max_interface_radius_delta_m": float(
                max((proof.radius_delta_m for proof in interface_proofs), default=float("inf"))
            ),
            "output_watertight": bool(topology.watertight) if topology else False,
            "output_boundary_edges": int(topology.boundary_edges) if topology else -1,
            "output_nonmanifold_edges": int(topology.nonmanifold_edges) if topology else -1,
            "output_manifold_component_count": (
                int(topology.manifold_component_count) if topology else -1
            ),
            "output_largest_manifold_component_faces": (
                int(topology.largest_manifold_component_faces) if topology else -1
            ),
            "source_watertight": bool(source_topology.watertight),
            "source_boundary_edges": int(source_topology.boundary_edges),
            "source_nonmanifold_edges": int(source_topology.nonmanifold_edges),
            "source_manifold_component_count": int(source_topology.manifold_component_count),
            "source_largest_manifold_component_faces": int(
                source_topology.largest_manifold_component_faces
            ),
            "surface_symmetric_chamfer_rms_m": float(
                surface_distance.symmetric_chamfer_rms_m if surface_distance else float("inf")
            ),
            "surface_symmetric_hausdorff_m": float(
                surface_distance.symmetric_hausdorff_m if surface_distance else float("inf")
            ),
        },
        "rings": ring_dicts,
        "skipped_levels": skipped_levels,
        "internal_skipped_levels": internal_skipped_levels,
        "nudged_levels": nudged_levels,
        "source_topology": asdict(source_topology),
        "interfaces": interface_dicts,
        "topology": asdict(topology) if topology else None,
        "surface_distance": asdict(surface_distance) if surface_distance else None,
    }
    return report


def write_spline_fit_proof(report: dict[str, Any], output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def _load_proof(path: Path, link: str) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if report.get("schema") != "asimov-1-spline-fit-proof-v1":
        return None
    if str(report.get("link", "")).upper() != link.upper():
        return None
    return report


def _proof_mesh_hashes_current(report: dict[str, Any]) -> bool:
    """Return whether a proof report is bound to the current source/output STLs."""
    mesh_path = Path(str(report.get("mesh_path", "")))
    output_mesh_path = Path(str(report.get("output_mesh_path", "")))
    mesh_sha256 = report.get("mesh_sha256")
    output_mesh_sha256 = report.get("output_mesh_sha256")
    if not mesh_path.is_file() or not output_mesh_path.is_file():
        return False
    if not isinstance(mesh_sha256, str) or not isinstance(output_mesh_sha256, str):
        return False
    return (
        mesh_sha256 == sha256_file(mesh_path)
        and output_mesh_sha256 == sha256_file(output_mesh_path)
    )


def collect_spline_fit_proof_matrix(
    *,
    proof_root: Path = ASIMOV_PARAM_PROOFS,
    failed_root: Path | None = None,
    expected_links: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Summarize spline/interface/topology/distance proof coverage for all links."""
    expected_links = expected_links or load_connection_specs()
    if failed_root is None:
        default_failed_root = proof_root / "failed"
        failed_root = default_failed_root if default_failed_root.is_dir() else None
    records: list[dict[str, Any]] = []
    for link, spec in sorted(expected_links.items()):
        proof_path = proof_root / f"{link}.spline-fit.json"
        raw_proof = _load_proof(proof_path, link)
        proof_stale = bool(raw_proof and not _proof_mesh_hashes_current(raw_proof))
        proof = None if proof_stale else raw_proof
        failed_path = (failed_root / f"{link}.spline-fit.json") if failed_root else None
        raw_failed_attempt = _load_proof(failed_path, link) if failed_path else None
        failed_attempt_stale = bool(
            raw_failed_attempt and not _proof_mesh_hashes_current(raw_failed_attempt)
        )
        failed_attempt = None if failed_attempt_stale else raw_failed_attempt
        summary = proof.get("summary", {}) if proof else {}
        failed_summary = failed_attempt.get("summary", {}) if failed_attempt else {}
        tolerances = proof.get("tolerances", {}) if proof else {}
        failure_reasons = list(summary.get("failure_reasons", [])) if proof else []
        failed_attempt_reasons = (
            list(failed_summary.get("failure_reasons", [])) if failed_attempt else []
        )
        if failed_attempt_stale:
            failed_attempt_reasons.append("failed_attempt:stale_mesh_hash")
        spline_ok = bool(
            proof
            and summary.get("rings_fit", 0) > 0
            and summary.get("section_coverage_ok", True)
            and not any(str(reason).startswith("spline_fit:") for reason in failure_reasons)
        )
        interface_ok = bool(
            proof
            and summary.get("interfaces_checked", 0) > 0
            and summary.get("interfaces_checked") == summary.get("interfaces_ok")
        )
        topology_ok = bool(
            proof
            and summary.get("output_watertight")
            and summary.get("output_boundary_edges") == 0
            and summary.get("output_nonmanifold_edges") == 0
        )
        surface_ok = bool(
            proof
            and summary.get("surface_symmetric_hausdorff_m", float("inf"))
            <= tolerances.get("surface_distance_tolerance_m", -1)
        )
        missing: list[str] = []
        if proof is None:
            missing.append("proof")
        if not spline_ok:
            missing.append("spline_fit")
        if proof and not summary.get("section_coverage_ok", True):
            missing.append("section_coverage")
        if proof is None and any(
            str(reason).startswith("section_coverage:") for reason in failed_attempt_reasons
        ):
            missing.append("section_coverage")
        if not interface_ok:
            missing.append("interface")
        if not topology_ok:
            missing.append("topology")
        if not surface_ok:
            missing.append("surface_distance")
        if not failure_reasons:
            if failed_attempt_reasons:
                failure_reasons = failed_attempt_reasons
            elif proof_stale:
                failure_reasons = ["proof:stale_mesh_hash"]
            else:
                failure_reasons = [
                    f"{proof_type}:missing_or_unproven"
                    for proof_type in missing
                    if proof_type != "proof"
                ]
        diagnostic_path = str(failed_path) if failed_attempt else None
        diagnostic_report = proof or failed_attempt or {}
        diagnostic_summary = diagnostic_report.get("summary", {})
        diagnostic_source_topology = diagnostic_report.get("source_topology") or {}
        diagnostic_topology = diagnostic_report.get("topology") or {}
        diagnostic_rings = list(diagnostic_report.get("rings", []))
        failed_rings = [ring for ring in diagnostic_rings if not ring.get("ok", False)]
        worst_ring = (
            max(
                failed_rings,
                key=lambda ring: (
                    float(ring.get("max_error_m", 0.0)),
                    float(ring.get("rms_error_m", 0.0)),
                ),
            )
            if failed_rings
            else None
        )
        records.append(
            {
                "link": link,
                "axis": spec.get("spine"),
                "proof": str(proof_path) if proof else None,
                "proof_stale": proof_stale,
                "failed_attempt": diagnostic_path,
                "failed_attempt_stale": failed_attempt_stale,
                "ok": bool(spline_ok and interface_ok and topology_ok and surface_ok),
                "spline_fit": spline_ok,
                "interface": interface_ok,
                "topology": topology_ok,
                "surface_distance": surface_ok,
                "missing": missing,
                "failure_reasons": failure_reasons,
                "rings_fit": int(summary.get("rings_fit", 0)) if proof else 0,
                "diagnostic_rings_fit": int(diagnostic_summary.get("rings_fit", 0)),
                "diagnostic_rings_skipped": int(diagnostic_summary.get("rings_skipped", 0)),
                "diagnostic_internal_rings_skipped": int(
                    diagnostic_summary.get("internal_rings_skipped", 0)
                ),
                "diagnostic_section_span_ratio": (
                    float(diagnostic_summary["section_span_ratio"])
                    if "section_span_ratio" in diagnostic_summary
                    else None
                ),
                "diagnostic_min_section_span_ratio": (
                    float(diagnostic_summary["min_section_span_ratio"])
                    if "min_section_span_ratio" in diagnostic_summary
                    else None
                ),
                "diagnostic_internal_skipped_levels": [
                    float(level)
                    for level in diagnostic_report.get("internal_skipped_levels", [])
                ],
                "diagnostic_failed_ring_count": int(len(failed_rings)),
                "diagnostic_worst_ring_level": (
                    float(worst_ring["level"]) if worst_ring else None
                ),
                "diagnostic_worst_ring_max_error_m": (
                    float(worst_ring["max_error_m"]) if worst_ring else None
                ),
                "diagnostic_worst_ring_rms_error_m": (
                    float(worst_ring["rms_error_m"]) if worst_ring else None
                ),
                "diagnostic_boundary_edges": (
                    int(diagnostic_topology["boundary_edges"])
                    if "boundary_edges" in diagnostic_topology
                    else None
                ),
                "diagnostic_nonmanifold_edges": (
                    int(diagnostic_topology["nonmanifold_edges"])
                    if "nonmanifold_edges" in diagnostic_topology
                    else None
                ),
                "diagnostic_manifold_component_count": (
                    int(diagnostic_topology["manifold_component_count"])
                    if "manifold_component_count" in diagnostic_topology
                    else None
                ),
                "diagnostic_largest_manifold_component_faces": (
                    int(diagnostic_topology["largest_manifold_component_faces"])
                    if "largest_manifold_component_faces" in diagnostic_topology
                    else None
                ),
                "diagnostic_source_boundary_edges": (
                    int(diagnostic_source_topology["boundary_edges"])
                    if "boundary_edges" in diagnostic_source_topology
                    else None
                ),
                "diagnostic_source_nonmanifold_edges": (
                    int(diagnostic_source_topology["nonmanifold_edges"])
                    if "nonmanifold_edges" in diagnostic_source_topology
                    else None
                ),
                "diagnostic_source_manifold_component_count": (
                    int(diagnostic_source_topology["manifold_component_count"])
                    if "manifold_component_count" in diagnostic_source_topology
                    else None
                ),
                "diagnostic_source_largest_manifold_component_faces": (
                    int(diagnostic_source_topology["largest_manifold_component_faces"])
                    if "largest_manifold_component_faces" in diagnostic_source_topology
                    else None
                ),
                "interfaces_checked": int(summary.get("interfaces_checked", 0)) if proof else 0,
                "surface_symmetric_hausdorff_m": (
                    float(summary["surface_symmetric_hausdorff_m"])
                    if proof and "surface_symmetric_hausdorff_m" in summary
                    else None
                ),
            }
        )
    proofed = sum(1 for record in records if record["proof"])
    failed_attempts = sum(1 for record in records if record["failed_attempt"])
    passed = sum(1 for record in records if record["ok"])
    reason_counts: dict[str, int] = {}
    for record in records:
        for reason in record["failure_reasons"]:
            category = str(reason).split(":", 1)[0]
            reason_counts[category] = reason_counts.get(category, 0) + 1
    return {
        "schema": "asimov-1-spline-fit-proof-matrix-v1",
        "ok": passed == len(records) and bool(records),
        "counts": {
            "expected_links": len(records),
            "proof_reports": proofed,
            "failed_attempt_reports": failed_attempts,
            "passed": passed,
            "missing_or_failed": len(records) - passed,
            "spline_fit": sum(1 for record in records if record["spline_fit"]),
            "interface": sum(1 for record in records if record["interface"]),
            "topology": sum(1 for record in records if record["topology"]),
            "surface_distance": sum(1 for record in records if record["surface_distance"]),
        },
        "failure_reason_counts": reason_counts,
        "records": records,
    }


def rank_spline_fit_repair_targets(
    *,
    matrix: dict[str, Any] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Rank failed ASIMOV spline proofs by the smallest likely geometry repair first."""
    matrix = matrix or collect_spline_fit_proof_matrix()
    targets: list[dict[str, Any]] = []
    for record in matrix.get("records", []):
        if record.get("ok"):
            continue
        missing = set(record.get("missing", []))
        failed_rings = int(record.get("diagnostic_failed_ring_count") or 0)
        internal_skips = int(record.get("diagnostic_internal_rings_skipped") or 0)
        boundary_edges = int(record.get("diagnostic_boundary_edges") or 0)
        nonmanifold_edges = int(record.get("diagnostic_nonmanifold_edges") or 0)
        topology_edges = boundary_edges + nonmanifold_edges
        source_boundary_edges = int(record.get("diagnostic_source_boundary_edges") or 0)
        source_nonmanifold_edges = int(record.get("diagnostic_source_nonmanifold_edges") or 0)
        failure_reasons = [str(reason) for reason in record.get("failure_reasons", [])]
        interface_failures = sum(
            1 for reason in failure_reasons if reason.startswith("interface:")
        )
        surface_failures = sum(
            1 for reason in failure_reasons if reason.startswith("surface_distance:")
        )
        inherited_topology = (
            topology_edges > 0
            and boundary_edges == source_boundary_edges
            and nonmanifold_edges == source_nonmanifold_edges
        )
        section_only_missing = {
            "proof",
            "spline_fit",
            "section_coverage",
            "interface",
            "topology",
            "surface_distance",
        }
        section_only = (
            missing == section_only_missing
            and failed_rings == 0
            and topology_edges == 0
            and internal_skips > 0
        )
        if section_only:
            category = "section_coverage_only"
            next_action = "repair skipped internal cross-sections, then regenerate the proof"
            score = internal_skips
        elif (
            topology_edges == 0
            and failed_rings == 0
            and internal_skips == 0
            and interface_failures > 0
        ):
            category = "interface_only"
            next_action = "repair reserved connection slab preservation before topology work"
            score = 50 + interface_failures
        elif (
            topology_edges == 0
            and failed_rings == 0
            and internal_skips == 0
            and surface_failures > 0
        ):
            category = "surface_distance_only"
            next_action = "reduce source/output surface distance before topology work"
            score = 75 + surface_failures
        elif topology_edges == 0:
            category = "spline_or_coverage"
            next_action = "improve ring fit and internal coverage before topology work"
            score = 100 + failed_rings * 10 + internal_skips
        elif failed_rings == 0:
            category = "inherited_topology" if inherited_topology else "coverage_topology"
            next_action = (
                "rebuild a clean loft or repair inherited source STL topology"
                if inherited_topology
                else "repair topology and internal section coverage"
            )
            score = 200 + topology_edges + internal_skips * 10
        else:
            category = "spline_topology"
            next_action = "resolve ring fit errors before final topology sealing"
            score = 300 + topology_edges + failed_rings * 10 + internal_skips
        targets.append(
            {
                "link": record["link"],
                "axis": record.get("axis"),
                "category": category,
                "score": int(score),
                "next_action": next_action,
                "missing": list(record.get("missing", [])),
                "failure_reasons": failure_reasons,
                "failed_ring_count": failed_rings,
                "internal_rings_skipped": internal_skips,
                "section_span_ratio": record.get("diagnostic_section_span_ratio"),
                "worst_ring_level": record.get("diagnostic_worst_ring_level"),
                "worst_ring_max_error_m": record.get("diagnostic_worst_ring_max_error_m"),
                "worst_ring_rms_error_m": record.get("diagnostic_worst_ring_rms_error_m"),
                "boundary_edges": boundary_edges,
                "nonmanifold_edges": nonmanifold_edges,
                "source_boundary_edges": source_boundary_edges,
                "source_nonmanifold_edges": source_nonmanifold_edges,
                "inherited_topology": bool(inherited_topology),
            }
        )
    targets.sort(
        key=lambda target: (
            target["score"],
            target["failed_ring_count"],
            target["internal_rings_skipped"],
            target["boundary_edges"] + target["nonmanifold_edges"],
            target["link"],
        )
    )
    if limit is not None:
        targets = targets[:limit]
    category_counts: dict[str, int] = {}
    for target in targets:
        category = str(target["category"])
        category_counts[category] = category_counts.get(category, 0) + 1
    return {
        "schema": "asimov-1-spline-fit-repair-ranking-v1",
        "ok": matrix.get("ok", False),
        "counts": {
            "expected_links": matrix.get("counts", {}).get("expected_links", 0),
            "passed": matrix.get("counts", {}).get("passed", 0),
            "ranked_targets": len(targets),
        },
        "category_counts": category_counts,
        "targets": targets,
    }
