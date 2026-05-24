"""Surface quality proof scaffold for ASIMOV fembot geometry.

This module measures the current ASIMOV STL meshes as source geometry evidence.
It does not accept the production fembot flatness/smoothness proof by itself:
final acceptance requires generated STEP/loft surfaces plus process-specific
tolerances for the thinned fembot parts.
"""

from __future__ import annotations

import json
import struct
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_MESH_DIR


SURFACE_QUALITY_SCHEMA = "asimov-fembot-surface-quality-proof-v1"


def _load_stl_triangles(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    if len(raw) >= 84:
        tri_count = struct.unpack_from("<I", raw, 80)[0]
        expected_len = 84 + tri_count * 50
        if expected_len == len(raw):
            triangles = np.empty((tri_count, 3, 3), dtype=np.float64)
            offset = 84
            for i in range(tri_count):
                offset += 12
                coords = struct.unpack_from("<9f", raw, offset)
                triangles[i] = np.array(coords, dtype=np.float64).reshape(3, 3)
                offset += 38
            return triangles

    vertices: list[list[float]] = []
    for line in raw.decode("utf-8", errors="ignore").splitlines():
        parts = line.strip().split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
    if len(vertices) % 3 != 0:
        raise ValueError(f"STL vertex count is not divisible by 3: {path}")
    return np.asarray(vertices, dtype=np.float64).reshape((-1, 3, 3))


def _face_geometry(triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    edges_a = triangles[:, 1] - triangles[:, 0]
    edges_b = triangles[:, 2] - triangles[:, 0]
    cross = np.cross(edges_a, edges_b)
    double_area = np.linalg.norm(cross, axis=1)
    valid = double_area > 0.0
    normals = np.zeros_like(cross)
    normals[valid] = cross[valid] / double_area[valid, None]
    areas = double_area * 0.5
    centroids = triangles.mean(axis=1)
    return normals, areas, centroids


def _canonical_plane_key(
    normal: np.ndarray,
    point: np.ndarray,
    *,
    normal_bin: float,
    offset_bin_m: float,
) -> tuple[int, int, int, int]:
    n = normal.copy()
    axis = int(np.argmax(np.abs(n)))
    if n[axis] < 0:
        n = -n
    offset = float(np.dot(n, point))
    return (
        int(round(float(n[0]) / normal_bin)),
        int(round(float(n[1]) / normal_bin)),
        int(round(float(n[2]) / normal_bin)),
        int(round(offset / offset_bin_m)),
    )


def _largest_planar_patch(
    triangles: np.ndarray,
    normals: np.ndarray,
    areas: np.ndarray,
    centroids: np.ndarray,
    *,
    normal_bin: float = 1.0e-3,
    offset_bin_m: float = 2.5e-4,
) -> dict[str, Any]:
    plane_faces: dict[tuple[int, int, int, int], list[int]] = {}
    for index, area in enumerate(areas):
        if area <= 0.0:
            continue
        key = _canonical_plane_key(
            normals[index],
            centroids[index],
            normal_bin=normal_bin,
            offset_bin_m=offset_bin_m,
        )
        plane_faces.setdefault(key, []).append(index)

    if not plane_faces:
        return {
            "face_count": 0,
            "area_m2": 0.0,
            "area_fraction": 0.0,
            "flatness_error_m": None,
            "normal_deviation_max_rad": None,
        }

    best_faces = max(plane_faces.values(), key=lambda faces: float(areas[faces].sum()))
    best_normals = normals[best_faces]
    best_areas = areas[best_faces]
    weighted_normal = (best_normals * best_areas[:, None]).sum(axis=0)
    norm = float(np.linalg.norm(weighted_normal))
    if norm == 0.0:
        normal = best_normals[0]
    else:
        normal = weighted_normal / norm
    if normal[int(np.argmax(np.abs(normal)))] < 0:
        normal = -normal

    patch_vertices = triangles[best_faces].reshape((-1, 3))
    origin = patch_vertices.mean(axis=0)
    distances = np.abs((patch_vertices - origin) @ normal)
    normal_dots = np.clip(np.abs(best_normals @ normal), -1.0, 1.0)
    normal_angles = np.arccos(normal_dots)
    total_area = float(areas.sum())
    patch_area = float(best_areas.sum())
    return {
        "face_count": len(best_faces),
        "area_m2": patch_area,
        "area_fraction": patch_area / total_area if total_area > 0.0 else 0.0,
        "flatness_error_m": float(distances.max()) if len(distances) else None,
        "normal_deviation_max_rad": float(normal_angles.max()) if len(normal_angles) else None,
    }


def _adjacent_normal_angles(
    triangles: np.ndarray,
    normals: np.ndarray,
    *,
    vertex_bin_m: float = 1.0e-8,
) -> np.ndarray:
    quantized = np.rint(triangles / vertex_bin_m).astype(np.int64)
    edge_vertices = np.asarray(((0, 1), (1, 2), (2, 0)), dtype=np.int64)
    raw_edges = quantized[:, edge_vertices, :].reshape((-1, 2, 3))
    starts = raw_edges[:, 0, :]
    ends = raw_edges[:, 1, :]
    swap = (
        (starts[:, 0] > ends[:, 0])
        | ((starts[:, 0] == ends[:, 0]) & (starts[:, 1] > ends[:, 1]))
        | (
            (starts[:, 0] == ends[:, 0])
            & (starts[:, 1] == ends[:, 1])
            & (starts[:, 2] > ends[:, 2])
        )
    )
    edge_min = np.where(swap[:, None], ends, starts)
    edge_max = np.where(swap[:, None], starts, ends)
    keys = np.concatenate((edge_min, edge_max), axis=1)
    face_indices = np.repeat(np.arange(len(triangles), dtype=np.int64), 3)
    order = np.lexsort(tuple(keys[:, i] for i in reversed(range(keys.shape[1]))))
    sorted_keys = keys[order]
    sorted_faces = face_indices[order]
    if len(sorted_keys) < 2:
        return np.asarray([], dtype=np.float64)

    same_as_prev = np.all(sorted_keys[1:] == sorted_keys[:-1], axis=1)
    shared = np.flatnonzero(same_as_prev)
    if len(shared) == 0:
        return np.asarray([], dtype=np.float64)
    faces_a = sorted_faces[shared]
    faces_b = sorted_faces[shared + 1]
    distinct = faces_a != faces_b
    faces_a = faces_a[distinct]
    faces_b = faces_b[distinct]
    if len(faces_a) == 0:
        return np.asarray([], dtype=np.float64)
    dots = np.clip(
        np.einsum("ij,ij->i", normals[faces_a], normals[faces_b]),
        -1.0,
        1.0,
    )
    return np.arccos(dots)


def _surface_class(largest_patch: dict[str, Any]) -> str:
    area_fraction = float(largest_patch.get("area_fraction") or 0.0)
    if area_fraction >= 0.20:
        return "flat-dominant-source-mesh"
    return "smooth-or-complex-source-mesh"


def measure_surface_quality_for_stl(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return _measure_surface_quality_for_stl_cached(str(path), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=128)
def _measure_surface_quality_for_stl_cached(
    path_str: str,
    mtime_ns: int,
    size_bytes: int,
) -> dict[str, Any]:
    del mtime_ns, size_bytes
    path = Path(path_str)
    triangles = _load_stl_triangles(path)
    normals, areas, centroids = _face_geometry(triangles)
    largest_patch = _largest_planar_patch(triangles, normals, areas, centroids)
    adjacent_angles = _adjacent_normal_angles(triangles, normals)
    bounds = np.stack((triangles.min(axis=(0, 1)), triangles.max(axis=(0, 1))))
    extents = bounds[1] - bounds[0]
    angle_p95 = float(np.percentile(adjacent_angles, 95)) if len(adjacent_angles) else None
    angle_max = float(adjacent_angles.max()) if len(adjacent_angles) else None
    return {
        "link": path.stem.upper(),
        "part_id": path.stem.upper(),
        "surface_id": f"{path.stem.upper()}:source-stl",
        "source_path": str(path),
        "source_sha256": sha256_file(path),
        "source_kind": "source_stl_baseline",
        "triangle_count": int(len(triangles)),
        "area_m2": float(areas.sum()),
        "bbox_min_m": [float(value) for value in bounds[0]],
        "bbox_max_m": [float(value) for value in bounds[1]],
        "bbox_extent_m": [float(value) for value in extents],
        "surface_class": _surface_class(largest_patch),
        "largest_planar_patch": largest_patch,
        "flatness_error_m": largest_patch["flatness_error_m"],
        "curvature_discontinuity_max": angle_max,
        "normal_deviation_max_rad": largest_patch["normal_deviation_max_rad"],
        "adjacent_normal_angle_p95_rad": angle_p95,
        "adjacent_normal_angle_max_rad": angle_max,
        "accepted": False,
        "acceptance_blocker": (
            "measured source STL only; production fembot acceptance requires generated "
            "STEP/loft surfaces, material/process tolerances, and identified flat or smooth zones"
        ),
    }


def build_fembot_surface_quality_proof(
    body_groups: list[dict[str, Any]],
    *,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
) -> dict[str, Any]:
    measurements_by_link: dict[str, dict[str, Any]] = {}
    for path in sorted(mesh_dir.glob("*.STL")):
        measurements_by_link[path.stem.upper()] = measure_surface_quality_for_stl(path)

    group_records: list[dict[str, Any]] = []
    missing_links: list[str] = []
    for group in body_groups:
        links = [str(link).upper() for link in group.get("links", [])]
        surfaces = []
        for link in links:
            record = measurements_by_link.get(link)
            if record is None:
                missing_links.append(link)
            else:
                surfaces.append(record)
        group_records.append(
            {
                "group": group.get("group"),
                "links": links,
                "surface_count": len(surfaces),
                "accepted": False,
                "surfaces": surfaces,
            }
        )

    measured = [surface for group in group_records for surface in group["surfaces"]]
    flat_dominant = [
        surface
        for surface in measured
        if surface["surface_class"] == "flat-dominant-source-mesh"
    ]
    smooth_or_complex = [
        surface
        for surface in measured
        if surface["surface_class"] == "smooth-or-complex-source-mesh"
    ]
    max_flatness = max(
        (surface["flatness_error_m"] or 0.0 for surface in measured),
        default=None,
    )
    max_adjacent_angle = max(
        (surface["adjacent_normal_angle_max_rad"] or 0.0 for surface in measured),
        default=None,
    )
    ok = len(missing_links) == 0 and len(measured) > 0
    return {
        "schema": SURFACE_QUALITY_SCHEMA,
        "ok": ok,
        "accepted": False,
        "mesh_dir": str(mesh_dir),
        "summary": {
            "measured_links": len(measured),
            "missing_links": sorted(set(missing_links)),
            "flat_dominant_source_meshes": len(flat_dominant),
            "smooth_or_complex_source_meshes": len(smooth_or_complex),
            "max_largest_patch_flatness_error_m": max_flatness,
            "max_adjacent_normal_angle_rad": max_adjacent_angle,
            "accepted": False,
            "acceptance_blocker": (
                "source mesh measurement exists, but generated fembot surfaces and "
                "process-specific tolerances are not yet available"
            ),
        },
        "body_groups": group_records,
    }


def dump_fembot_surface_quality_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_surface_quality_proof(report: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_surface_quality_proof_json(report), encoding="utf-8")
