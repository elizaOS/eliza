#!/usr/bin/env python3
"""Generate the Unitree R1 orange android hard-plastic bodykit.

The output is intentionally deterministic and parameter-driven: prototype
meshes, a MuJoCo bodykit XML, review renders, fit reports, and manufacturing
manifests all come from `mechanical/unitree-r1-bodykit/cad/bodykit_params.yaml`.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import subprocess
import shutil
import xml.etree.ElementTree as ET
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
import trimesh
import yaml
from PIL import Image, ImageDraw, ImageFilter, ImageStat
from scipy.spatial import cKDTree

PKG_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = PKG_ROOT / "mechanical" / "unitree-r1-bodykit"
PARAMS_PATH = PROJECT_ROOT / "cad" / "bodykit_params.yaml"
OUT_ROOT = PROJECT_ROOT / "out"
REVIEW_ROOT = PROJECT_ROOT / "review"
MESH_ROOT = OUT_ROOT / "meshes"
MJCF_ROOT = OUT_ROOT / "mjcf"
STEP_ROOT = OUT_ROOT / "step"
BASE_RECON_ROOT = OUT_ROOT / "base-reconstruction"
BASE_RECON_STEP_ROOT = BASE_RECON_ROOT / "step"
BASE_RECON_PARAM_ROOT = BASE_RECON_ROOT / "params"
R1_MJCF = PKG_ROOT / "assets" / "profiles" / "unitree-r1" / "mjcf" / "R1_C++.xml"
R1_ASSET_ROOT = R1_MJCF.parent / "assets"
_OEM_GEOM_CACHE: dict[str, list[dict[str, Any]]] | None = None


AXIS_INDEX = {"x": 0, "y": 1, "z": 2}


@dataclass(frozen=True)
class Part:
    name: str
    body: str
    role: str
    material: str
    source_kind: str
    source_asset: str | None
    oem_baseline_meshes: tuple[str, ...]
    mesh: trimesh.Trimesh
    stl_path: Path
    obj_path: Path


def _geom_type_name(model: mujoco.MjModel, geom_id: int) -> str:
    value = int(model.geom_type[geom_id])
    for name in dir(mujoco.mjtGeom):
        if name.startswith("mjGEOM_") and int(getattr(mujoco.mjtGeom, name)) == value:
            return name.removeprefix("mjGEOM_").lower()
    return str(value)


def _load_params() -> dict[str, Any]:
    with PARAMS_PATH.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict):
        raise ValueError(f"{PARAMS_PATH} did not parse to a mapping")
    return _apply_parametric_morphs(raw)


def _lerp(a: float, b: float, blend: float) -> float:
    return float(a) + (float(b) - float(a)) * blend


def _blend_vector(base: list[Any], target: list[Any], blend: float) -> list[float]:
    if len(base) != len(target):
        raise ValueError(f"cannot blend vectors of different length: {base!r} vs {target!r}")
    return [_lerp(float(a), float(b), blend) for a, b in zip(base, target)]


def _blend_loft_sections(base_sections: list[dict[str, Any]], target_sections: list[dict[str, Any]], blend: float) -> list[dict[str, Any]]:
    if len(base_sections) != len(target_sections):
        raise ValueError("section morph target must have the same number of sections as the base loft")
    out: list[dict[str, Any]] = []
    for base, target in zip(base_sections, target_sections):
        section = copy.deepcopy(base)
        coordinate_key = next((key for key in ("x", "y", "z", "position") if key in base or key in target), "z")
        section[coordinate_key] = _lerp(
            float(base.get(coordinate_key, base.get("z", 0.0))),
            float(target.get(coordinate_key, target.get("z", base.get(coordinate_key, 0.0)))),
            blend,
        )
        section["scale"] = _blend_vector(list(base["scale"]), list(target.get("scale", base["scale"])), blend)
        if "offset" in base or "offset" in target:
            base_offset = list(base.get("offset", [0.0, 0.0]))
            target_offset = list(target.get("offset", base_offset))
            section["offset"] = _blend_vector(base_offset, target_offset, blend)
        out.append(section)
    return out


def _blend_part_fields(spec: dict[str, Any], target: dict[str, Any], blend: float) -> list[str]:
    changed: list[str] = []
    vector_fields = {"center", "scale", "top_scale", "aesthetic_scale", "center_offset"}
    scalar_fields = {"radius", "tube_radius", "height"}
    for field in sorted(vector_fields):
        if field not in target:
            continue
        if field not in spec:
            raise ValueError(f"part target field {field!r} cannot be applied to {spec['name']}: base field missing")
        spec[field] = _blend_vector(list(spec[field]), list(target[field]), blend)
        changed.append(field)
    for field in sorted(scalar_fields):
        if field not in target:
            continue
        if field not in spec:
            raise ValueError(f"part target field {field!r} cannot be applied to {spec['name']}: base field missing")
        spec[field] = _lerp(float(spec[field]), float(target[field]), blend)
        changed.append(field)
    return changed


def _vector_delta_report(base: list[Any], target: list[Any]) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for index, (a, b) in enumerate(zip(base, target)):
        before = float(a)
        after = float(b)
        rows.append(
            {
                "axis_index": index,
                "base": round(before, 6),
                "target": round(after, 6),
                "delta": round(after - before, 6),
                "percent": round(((after - before) / before * 100.0), 3) if abs(before) > 1e-9 else 0.0,
            }
        )
    return rows


def _section_delta_report(base_sections: list[dict[str, Any]], target_sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, (base, target) in enumerate(zip(base_sections, target_sections)):
        coordinate_key = next((key for key in ("x", "y", "z", "position") if key in base or key in target), "z")
        rows.append(
            {
                "section_index": index,
                "axis": coordinate_key,
                "position_delta": round(
                    float(target.get(coordinate_key, target.get("z", base.get(coordinate_key, 0.0))))
                    - float(base.get(coordinate_key, base.get("z", 0.0))),
                    6,
                ),
                "scale_delta": _vector_delta_report(list(base["scale"]), list(target.get("scale", base["scale"]))),
            }
        )
    return rows


def _apply_parametric_morphs(raw: dict[str, Any]) -> dict[str, Any]:
    params = copy.deepcopy(raw)
    part_by_name = {str(part["name"]): part for part in params.get("parts", [])}
    applied: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for morph_name, morph in params.get("morphs", {}).items():
        if not isinstance(morph, dict):
            continue
        blend = float(morph.get("blend", 0.0))
        if blend <= 0.0:
            continue
        blend = min(blend, 1.0)
        for part_name, target in morph.get("section_targets", {}).items():
            spec = part_by_name.get(str(part_name))
            if spec is None:
                skipped.append({"morph": str(morph_name), "part": str(part_name), "reason": "missing part"})
                continue
            if str(spec.get("shape")) != "section_loft":
                skipped.append(
                    {
                        "morph": str(morph_name),
                        "part": str(part_name),
                        "reason": f"unsupported shape {spec.get('shape')!r}",
                    }
                )
                continue
            target_sections = target.get("sections", target) if isinstance(target, dict) else target
            if not isinstance(target_sections, list):
                skipped.append({"morph": str(morph_name), "part": str(part_name), "reason": "missing section target"})
                continue
            original_center = list(spec.get("center", [0.0, 0.0, 0.0]))
            if isinstance(target, dict) and "center" in target:
                spec["center"] = _blend_vector(original_center, list(target["center"]), blend)
            original_sections = copy.deepcopy(spec["sections"])
            spec["sections"] = _blend_loft_sections(original_sections, target_sections, blend)
            spec.setdefault("morph_history", []).append(
                {
                    "morph": str(morph_name),
                    "blend": blend,
                    "base_sections": original_sections,
                    "target_sections": target_sections,
                    "base_center": original_center,
                    "target_center": target.get("center") if isinstance(target, dict) else None,
                }
            )
            applied.append(
                {
                    "morph": str(morph_name),
                    "part": str(part_name),
                    "blend": blend,
                    "kind": "section_loft",
                    "section_deltas": _section_delta_report(original_sections, target_sections),
                    "center_delta": (
                        _vector_delta_report(original_center, list(target["center"]))
                        if isinstance(target, dict) and "center" in target
                        else []
                    ),
                }
            )
        for part_name, target in morph.get("part_targets", {}).items():
            spec = part_by_name.get(str(part_name))
            if spec is None:
                skipped.append({"morph": str(morph_name), "part": str(part_name), "reason": "missing part"})
                continue
            if not isinstance(target, dict):
                skipped.append({"morph": str(morph_name), "part": str(part_name), "reason": "part target is not a mapping"})
                continue
            field_deltas: dict[str, Any] = {}
            for field, value in target.items():
                if isinstance(value, list) and field in spec:
                    field_deltas[field] = _vector_delta_report(list(spec[field]), value)
                elif field in spec:
                    before = float(spec[field])
                    after = float(value)
                    field_deltas[field] = {
                        "base": round(before, 6),
                        "target": round(after, 6),
                        "delta": round(after - before, 6),
                        "percent": round(((after - before) / before * 100.0), 3) if abs(before) > 1e-9 else 0.0,
                    }
            try:
                changed = _blend_part_fields(spec, target, blend)
            except ValueError as exc:
                skipped.append({"morph": str(morph_name), "part": str(part_name), "reason": str(exc)})
                continue
            spec.setdefault("morph_history", []).append(
                {
                    "morph": str(morph_name),
                    "blend": blend,
                    "target_fields": sorted(target),
                    "changed_fields": changed,
                }
            )
            applied.append(
                {
                    "morph": str(morph_name),
                    "part": str(part_name),
                    "blend": blend,
                    "kind": "part_fields",
                    "fields": changed,
                    "field_deltas": field_deltas,
                }
            )
    params["_morph_application_report"] = {
        "verdict": "pass",
        "applied_count": len(applied),
        "skipped_count": len(skipped),
        "applied": applied,
        "skipped": skipped,
        "morphs": {
            str(name): {
                "blend": float(morph.get("blend", 0.0)) if isinstance(morph, dict) else 0.0,
                "intent": morph.get("intent") if isinstance(morph, dict) else None,
                "controls": morph.get("controls", {}) if isinstance(morph, dict) else {},
                "applied_parts": morph.get("applied_parts", []) if isinstance(morph, dict) else [],
            }
            for name, morph in params.get("morphs", {}).items()
        },
        "note": "Parametric morphs are applied in-memory before mesh, STEP, MuJoCo, fit, panel, and stress outputs.",
    }
    return params


def write_parametric_morph_report(params: dict[str, Any]) -> dict[str, Any]:
    report = params.get("_morph_application_report", {"verdict": "pass", "applied_count": 0, "skipped_count": 0})
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "parametric-morph-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def _rgba255(color: list[float]) -> np.ndarray:
    return (np.asarray(color, dtype=float) * 255).clip(0, 255).astype(np.uint8)


def _paint(mesh: trimesh.Trimesh, rgba: list[float]) -> trimesh.Trimesh:
    mesh.visual.face_colors = _rgba255(rgba)
    return mesh


def _ellipsoid(scale: list[float], rgba: list[float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.uv_sphere(segments=48, ring_count=24)
    mesh.apply_scale(scale)
    return _paint(mesh, rgba)


def _capsule(radius: float, height: float, axis: str, rgba: list[float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.capsule(radius=radius, height=height, count=[32, 16])
    if axis == "x":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
    elif axis == "y":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    return _paint(mesh, rgba)


def _box(scale: list[float], rgba: list[float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.box(extents=[float(x) * 2 for x in scale])
    return _paint(mesh, rgba)


def _tapered_box(scale: list[float], top_scale: list[float], rgba: list[float]) -> trimesh.Trimesh:
    sx, sy, sz = [float(x) for x in scale]
    tx, ty = [float(x) for x in top_scale[:2]]
    vertices = np.array(
        [
            [-sx, -sy, -sz],
            [sx, -sy, -sz],
            [sx, sy, -sz],
            [-sx, sy, -sz],
            [-tx, -ty, sz],
            [tx, -ty, sz],
            [tx, ty, sz],
            [-tx, ty, sz],
        ],
        dtype=float,
    )
    faces = np.array(
        [
            [0, 1, 2],
            [0, 2, 3],
            [4, 6, 5],
            [4, 7, 6],
            [0, 4, 5],
            [0, 5, 1],
            [1, 5, 6],
            [1, 6, 2],
            [2, 6, 7],
            [2, 7, 3],
            [3, 7, 4],
            [3, 4, 0],
        ],
        dtype=int,
    )
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    return _paint(mesh, rgba)


def _section_loft(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    axis = str(spec.get("axis", "z"))
    if axis not in AXIS_INDEX:
        raise ValueError("section_loft supports axis: x, y, or z")
    axis_index = AXIS_INDEX[axis]
    cross_axes = [i for i in range(3) if i != axis_index]
    segments = int(spec.get("segments", 48))
    sections = spec["sections"]
    vertices: list[list[float]] = []
    for section in sections:
        position = float(section.get(axis, section.get("position", section.get("z"))))
        sx, sy = [float(x) for x in section["scale"][:2]]
        offset = [float(x) for x in section.get("offset", [0.0, 0.0])]
        for i in range(segments):
            t = 2 * math.pi * i / segments
            point = [0.0, 0.0, 0.0]
            point[axis_index] = position
            point[cross_axes[0]] = offset[0] + sx * math.cos(t)
            point[cross_axes[1]] = offset[1] + sy * math.sin(t)
            vertices.append(point)
    faces: list[list[int]] = []
    for ring in range(len(sections) - 1):
        base = ring * segments
        nxt = (ring + 1) * segments
        for i in range(segments):
            j = (i + 1) % segments
            faces.append([base + i, nxt + i, nxt + j])
            faces.append([base + i, nxt + j, base + j])
    # Cap bottom and top with fan triangles around explicit center vertices.
    bottom_center = len(vertices)
    bottom = sections[0]
    bottom_position = float(bottom.get(axis, bottom.get("position", bottom.get("z"))))
    bottom_point = [0.0, 0.0, 0.0]
    bottom_point[axis_index] = bottom_position
    bottom_offset = [float(x) for x in bottom.get("offset", [0.0, 0.0])]
    bottom_point[cross_axes[0]] = bottom_offset[0]
    bottom_point[cross_axes[1]] = bottom_offset[1]
    vertices.append(bottom_point)
    top_center = len(vertices)
    top = sections[-1]
    top_position = float(top.get(axis, top.get("position", top.get("z"))))
    top_point = [0.0, 0.0, 0.0]
    top_point[axis_index] = top_position
    top_offset = [float(x) for x in top.get("offset", [0.0, 0.0])]
    top_point[cross_axes[0]] = top_offset[0]
    top_point[cross_axes[1]] = top_offset[1]
    vertices.append(top_point)
    for i in range(segments):
        j = (i + 1) % segments
        faces.append([bottom_center, j, i])
        top_base = (len(sections) - 1) * segments
        faces.append([top_center, top_base + i, top_base + j])
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float), faces=np.asarray(faces, dtype=int), process=True)
    return _paint(mesh, rgba)


def _source_mesh_vertices(spec: dict[str, Any]) -> np.ndarray:
    source = _resolve_project_path(str(spec["mesh_source"]))
    if not source.is_file():
        raise FileNotFoundError(f"source mesh does not exist: {source}")
    loaded = trimesh.load(source, force="mesh")
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError(f"source mesh has no mesh geometry: {source}")
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = loaded
    vertices = np.asarray(mesh.vertices, dtype=float).copy()
    units = str(spec.get("units", "m")).lower()
    if units in {"mm", "millimeter", "millimeters"}:
        vertices *= 0.001
    elif units in {"cm", "centimeter", "centimeters"}:
        vertices *= 0.01
    elif units not in {"m", "meter", "meters"}:
        raise ValueError(f"unsupported source mesh units {units!r} for {spec['name']}")
    if "scale" in spec:
        scale = spec["scale"]
        vertices *= np.asarray([float(x) for x in scale] if isinstance(scale, list) else [float(scale)] * 3)
    return vertices


def _donor_face_grid_sections(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Fit closed x/y section curves from the donor face over a fixed y/z grid."""
    vertices = _source_mesh_vertices(spec)
    sections = int(spec.get("sections_count", 17))
    samples = int(spec.get("samples_per_side", 18))
    shell_depth = float(spec.get("shell_depth_mm", 2.4)) / 1000.0
    face_depth_min = float(spec.get("face_depth_min_mm", 12.0)) / 1000.0
    fit_quantile = float(spec.get("front_fit_quantile", 0.985))
    y_shrink = float(spec.get("y_shrink", 0.0))
    x_slim = float(spec.get("x_slim_mm", 0.0)) / 1000.0
    feature_gain = float(spec.get("feature_gain", 1.0))
    nose_gain = float(spec.get("nose_gain", 0.35))
    lip_gain = float(spec.get("lip_gain", 0.16))
    cheek_gain = float(spec.get("cheek_gain", 0.08))
    brow_gain = float(spec.get("brow_gain", 0.05))
    bounds = np.asarray([vertices.min(axis=0), vertices.max(axis=0)], dtype=float)
    x_min, y_min, z_min = bounds[0]
    x_max, y_max, z_max = bounds[1]
    x_span = max(x_max - x_min, face_depth_min)
    y_mid = (y_min + y_max) / 2.0
    z_mid = (z_min + z_max) / 2.0
    y_half = (y_max - y_min) / 2.0 * (1.0 - y_shrink)
    z_half = (z_max - z_min) / 2.0
    yz_tree = cKDTree(vertices[:, [1, 2]])
    out: list[dict[str, Any]] = []
    for zi in range(sections):
        t = zi / max(sections - 1, 1)
        z = z_min + (z_max - z_min) * t
        zn = (z - z_mid) / max(z_half, 1e-9)
        oval = max(0.0, 1.0 - zn * zn)
        local_y_half = max(0.006, y_half * (oval**0.42))
        ys = np.linspace(-local_y_half, local_y_half, samples)
        front: list[list[float]] = []
        for y_rel in ys:
            y = y_mid + y_rel
            yn = y_rel / max(local_y_half, 1e-9)
            radius = max(0.004, 0.010 + 0.030 * (1.0 - abs(zn)))
            idxs = yz_tree.query_ball_point([y, z], r=radius)
            if len(idxs) < 8:
                _, nearest = yz_tree.query([y, z], k=min(48, len(vertices)))
                idxs = np.atleast_1d(nearest).astype(int).tolist()
            donor_front = float(np.quantile(vertices[idxs, 0], fit_quantile))
            base_oval_front = x_min + x_span * (0.74 + 0.20 * oval - 0.06 * abs(yn))
            x = max(donor_front, base_oval_front)
            nose = math.exp(-((yn / 0.30) ** 2 + ((t - 0.50) / 0.22) ** 2))
            lips = math.exp(-((yn / 0.42) ** 2 + ((t - 0.34) / 0.12) ** 2))
            cheeks = math.exp(-(((abs(yn) - 0.52) / 0.22) ** 2 + ((t - 0.46) / 0.26) ** 2))
            brow = math.exp(-((yn / 0.70) ** 2 + ((t - 0.67) / 0.10) ** 2))
            x += feature_gain * (nose_gain * nose + lip_gain * lips + cheek_gain * cheeks + brow_gain * brow) * x_span
            x -= x_slim
            front.append([x, y])
        back_x = min(x_min - shell_depth, max(p[0] for p in front) - face_depth_min)
        back: list[list[float]] = []
        for y_rel in reversed(ys):
            y = y_mid + y_rel
            yn = y_rel / max(local_y_half, 1e-9)
            edge_return = 0.20 * x_span * (1.0 - abs(yn))
            back.append([back_x + edge_return, y])
        points = front + back
        out.append({"z": z, "points": points})
    return out


def _donor_face_grid_loft(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    sections = _donor_face_grid_sections(spec)
    ring_count = len(sections[0]["points"])
    vertices: list[list[float]] = []
    for section in sections:
        for x, y in section["points"]:
            vertices.append([float(x), float(y), float(section["z"])])
    faces: list[list[int]] = []
    for ring in range(len(sections) - 1):
        base = ring * ring_count
        nxt = (ring + 1) * ring_count
        for i in range(ring_count):
            j = (i + 1) % ring_count
            faces.append([base + i, nxt + i, nxt + j])
            faces.append([base + i, nxt + j, base + j])
    bottom_center = len(vertices)
    bottom_points = np.asarray([[x, y, sections[0]["z"]] for x, y in sections[0]["points"]], dtype=float)
    vertices.append(bottom_points.mean(axis=0).tolist())
    top_center = len(vertices)
    top_points = np.asarray([[x, y, sections[-1]["z"]] for x, y in sections[-1]["points"]], dtype=float)
    vertices.append(top_points.mean(axis=0).tolist())
    top_base = (len(sections) - 1) * ring_count
    for i in range(ring_count):
        j = (i + 1) % ring_count
        faces.append([bottom_center, j, i])
        faces.append([top_center, top_base + i, top_base + j])
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float), faces=np.asarray(faces, dtype=int), process=True)
    return _paint(mesh, rgba)


def _cylinder(radius: float, height: float, axis: str, rgba: list[float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=32)
    if axis == "x":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
    elif axis == "y":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    return _paint(mesh, rgba)


def _torus(radius: float, tube_radius: float, axis: str, scale: list[float] | None, rgba: list[float]) -> trimesh.Trimesh:
    mesh = trimesh.creation.torus(major_radius=radius, minor_radius=tube_radius, major_sections=48, minor_sections=12)
    if axis == "x":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
    elif axis == "y":
        mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    if scale:
        mesh.apply_scale([float(x) for x in scale])
    return _paint(mesh, rgba)


def _quat_matrix(quat: list[float]) -> np.ndarray:
    w, x, y, z = quat
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=float,
    )


def _mesh_file_map() -> dict[str, str]:
    tree = ET.parse(R1_MJCF)
    root = tree.getroot()
    out = {}
    for mesh in root.findall("./asset/mesh"):
        name = mesh.attrib.get("name")
        file_name = mesh.attrib.get("file")
        if name and file_name:
            out[name] = file_name
    return out


def _oem_geom_cache() -> dict[str, list[dict[str, Any]]]:
    global _OEM_GEOM_CACHE
    if _OEM_GEOM_CACHE is not None:
        return _OEM_GEOM_CACHE
    mesh_files = _mesh_file_map()
    tree = ET.parse(R1_MJCF)
    root = tree.getroot()
    cache: dict[str, list[dict[str, Any]]] = {}
    for body in root.iter("body"):
        body_name = body.attrib.get("name")
        if not body_name:
            continue
        entries = []
        for geom in body.findall("geom"):
            mesh_name = geom.attrib.get("mesh")
            if not mesh_name or mesh_name not in mesh_files:
                continue
            pos = [float(x) for x in geom.attrib.get("pos", "0 0 0").split()]
            quat = [float(x) for x in geom.attrib.get("quat", "1 0 0 0").split()]
            entries.append(
                {
                    "mesh_name": mesh_name,
                    "file": mesh_files[mesh_name],
                    "pos": pos,
                    "quat": quat,
                }
            )
        cache[body_name] = entries
    _OEM_GEOM_CACHE = cache
    return cache


def _oem_body_mesh(body_name: str, requested_files: list[str]) -> trimesh.Trimesh:
    requested = {Path(name).stem for name in requested_files}
    meshes = []
    for entry in _oem_geom_cache().get(body_name, []):
        if Path(entry["file"]).stem not in requested and entry["mesh_name"] not in requested:
            continue
        path = R1_ASSET_ROOT / entry["file"]
        mesh = trimesh.load_mesh(path, force="mesh").copy()
        transform = np.eye(4)
        transform[:3, :3] = _quat_matrix(entry["quat"])
        transform[:3, 3] = np.asarray(entry["pos"], dtype=float)
        mesh.apply_transform(transform)
        meshes.append(mesh)
    if not meshes:
        raise ValueError(f"no mounted OEM meshes found for body {body_name}: {requested_files}")
    combined = trimesh.util.concatenate(meshes)
    combined.remove_unreferenced_vertices()
    return combined


def _oem_inflated_hull(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    body_name = str(spec["body"])
    requested = [str(x) for x in spec.get("oem_baseline_meshes", [])]
    base = _oem_body_mesh(body_name, requested)
    points = np.asarray(base.vertices, dtype=float)
    if "source_bounds" in spec:
        bounds = spec["source_bounds"]
        axis_index = {"x": 0, "y": 1, "z": 2}
        keep = np.ones(len(points), dtype=bool)
        for axis, limit in bounds.items():
            if axis not in axis_index:
                raise ValueError(f"unsupported source_bounds axis {axis!r} for {spec['name']}")
            lo, hi = [float(x) for x in limit]
            values = points[:, axis_index[axis]]
            keep &= (values >= lo) & (values <= hi)
        filtered = points[keep]
        if len(filtered) >= 16:
            points = filtered
    if len(points) > 2400:
        points = points[np.linspace(0, len(points) - 1, 2400, dtype=int)]
    hull = trimesh.convex.convex_hull(points)
    vertices = np.asarray(hull.vertices, dtype=float)
    center = vertices.mean(axis=0)
    directions = vertices - center
    lengths = np.linalg.norm(directions, axis=1)
    directions[lengths > 1e-8] /= lengths[lengths > 1e-8, None]
    inflate = float(spec.get("inflate_mm", 12.0)) / 1000.0
    hull.vertices = vertices + directions * inflate
    if "aesthetic_scale" in spec:
        scale = np.asarray([float(x) for x in spec["aesthetic_scale"]], dtype=float)
        hull.vertices = center + (np.asarray(hull.vertices) - center) * scale
    if "center_offset" in spec:
        hull.apply_translation([float(x) for x in spec["center_offset"]])
    hull.merge_vertices()
    return _paint(hull, rgba)


def _resolve_project_path(raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return PROJECT_ROOT / path


def _fit_image_cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((math.ceil(image.width * scale), math.ceil(image.height * scale)))
    left = max((resized.width - target_w) // 2, 0)
    top = max((resized.height - target_h) // 2, 0)
    return resized.crop((left, top, left + target_w, top + target_h))


def _concept_reference_path(params: dict[str, Any]) -> Path | None:
    raw = params.get("style", {}).get("concept_reference_image")
    if not raw:
        return None
    path = _resolve_project_path(str(raw))
    return path if path.is_file() else None


def _concept_reference_mesh_path(params: dict[str, Any]) -> Path | None:
    raw = params.get("style", {}).get("concept_reference_mesh")
    if not raw:
        return None
    path = _resolve_project_path(str(raw))
    return path if path.is_file() else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_concept_reference_report(params: dict[str, Any]) -> dict[str, Any]:
    image_path = _concept_reference_path(params)
    mesh_path = _concept_reference_mesh_path(params)
    source_image = Path("/home/shaw/Downloads/eliza_front.png")
    source_mesh = Path("/home/shaw/Downloads/eliza_front.glb")
    report: dict[str, Any] = {
        "verdict": "pass" if image_path and mesh_path else "needs-work",
        "usage": params.get("style", {}).get("concept_reference_usage"),
        "image": None,
        "mesh": None,
        "source_match": {
            "source_png": str(source_image),
            "source_glb": str(source_mesh),
            "source_png_exists": source_image.is_file(),
            "source_glb_exists": source_mesh.is_file(),
            "png_hash_match": None,
            "glb_hash_match": None,
        },
        "note": (
            "The concept GLB is a single AI-generated reference mesh for scale, silhouette, "
            "face/eye proportions, heel/boot language, and orange-black panel vocabulary. "
            "It is not used as production geometry."
        ),
    }
    if image_path:
        image = Image.open(image_path)
        report["image"] = {
            "path": str(image_path),
            "width": image.width,
            "height": image.height,
            "bytes": image_path.stat().st_size,
            "sha256": _sha256(image_path),
        }
        if source_image.is_file():
            source_hash = _sha256(source_image)
            report["source_match"]["source_png_sha256"] = source_hash
            report["source_match"]["png_hash_match"] = source_hash == report["image"]["sha256"]
    if mesh_path:
        loaded = trimesh.load(mesh_path, force="scene")
        meshes = []
        if isinstance(loaded, trimesh.Scene):
            meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
            mesh = trimesh.util.concatenate(meshes) if meshes else None
        else:
            mesh = loaded
            meshes = [mesh]
        if mesh is not None:
            extents = np.asarray(mesh.extents, dtype=float)
            report["mesh"] = {
                "path": str(mesh_path),
                "mesh_count": len(meshes),
                "vertices": int(len(mesh.vertices)),
                "faces": int(len(mesh.faces)),
                "bounds_m": np.asarray(mesh.bounds, dtype=float).round(5).tolist(),
                "extents_m": extents.round(5).tolist(),
                "height_axis": "y",
                "height_m": round(float(extents[1]), 5),
                "unitree_r1_height_reference_m": 1.23,
                "scale_to_r1_height": round(1.23 / float(extents[1]), 5) if extents[1] else None,
                "sha256": _sha256(mesh_path),
            }
            if source_mesh.is_file():
                source_hash = _sha256(source_mesh)
                report["source_match"]["source_glb_sha256"] = source_hash
                report["source_match"]["glb_hash_match"] = source_hash == report["mesh"]["sha256"]
    if image_path and mesh_path:
        source = report["source_match"]
        report["verdict"] = (
            "pass"
            if (
                report["image"]
                and report["mesh"]
                and report["image"]["width"] > 0
                and report["image"]["height"] > 0
                and report["mesh"]["vertices"] > 1000
                and report["mesh"]["faces"] > 1000
                and (source["png_hash_match"] in {True, None})
                and (source["glb_hash_match"] in {True, None})
            )
            else "needs-work"
        )
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "reference-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def _imported_mesh(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    source = _resolve_project_path(str(spec["mesh_source"]))
    if not source.is_file():
        raise FileNotFoundError(f"imported bodykit mesh does not exist: {source}")
    loaded = trimesh.load(source, force="mesh")
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError(f"imported bodykit mesh has no mesh geometry: {source}")
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = loaded
    mesh = mesh.copy()
    units = str(spec.get("units", "m")).lower()
    if units in {"mm", "millimeter", "millimeters"}:
        mesh.apply_scale(0.001)
    elif units in {"cm", "centimeter", "centimeters"}:
        mesh.apply_scale(0.01)
    elif units not in {"m", "meter", "meters"}:
        raise ValueError(f"unsupported imported mesh units {units!r} for {spec['name']}")
    if "scale" in spec:
        scale = spec["scale"]
        mesh.apply_scale([float(x) for x in scale] if isinstance(scale, list) else float(scale))
    if "rotation_euler_deg" in spec:
        rx, ry, rz = [math.radians(float(x)) for x in spec["rotation_euler_deg"]]
        matrix = trimesh.transformations.euler_matrix(rx, ry, rz, axes="sxyz")
        mesh.apply_transform(matrix)
    if "center" in spec:
        mesh.apply_translation([float(x) for x in spec["center"]])
    mesh.remove_unreferenced_vertices()
    return _paint(mesh, rgba)


def _donor_face_surface_loft(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    # The render/collision mesh intentionally keeps the transformed donor
    # surface. The matching STEP path below rebuilds it as CAD loft sections.
    return _imported_mesh(spec, rgba)


def _face(scale: list[float], rgba: list[float]) -> trimesh.Trimesh:
    head = _ellipsoid(scale, rgba)
    # A small hard-plastic nose bridge gives the face directionality without
    # creating fragile overhangs for printing or molding.
    nose = trimesh.creation.cone(radius=0.012, height=0.030, sections=32)
    nose.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
    nose.apply_translation([scale[0] * 0.93, 0, -scale[2] * 0.05])
    cheek_l = _ellipsoid([0.012, 0.018, 0.010], rgba)
    cheek_l.apply_translation([scale[0] * 0.78, scale[1] * 0.35, -scale[2] * 0.12])
    cheek_r = _ellipsoid([0.012, 0.018, 0.010], rgba)
    cheek_r.apply_translation([scale[0] * 0.78, -scale[1] * 0.35, -scale[2] * 0.12])
    face = trimesh.util.concatenate([head, _paint(nose, rgba), cheek_l, cheek_r])
    face.merge_vertices()
    return face


def _part_mesh(spec: dict[str, Any], rgba: list[float]) -> trimesh.Trimesh:
    shape = str(spec["shape"])
    if shape == "ellipsoid":
        mesh = _ellipsoid([float(x) for x in spec["scale"]], rgba)
    elif shape == "capsule_z":
        mesh = _capsule(float(spec["radius"]), float(spec["height"]), "z", rgba)
    elif shape == "capsule_x":
        mesh = _capsule(float(spec["radius"]), float(spec["height"]), "x", rgba)
    elif shape == "capsule_y":
        mesh = _capsule(float(spec["radius"]), float(spec["height"]), "y", rgba)
    elif shape == "box":
        mesh = _box([float(x) for x in spec["scale"]], rgba)
    elif shape == "tapered_box":
        mesh = _tapered_box([float(x) for x in spec["scale"]], [float(x) for x in spec["top_scale"]], rgba)
    elif shape == "section_loft":
        mesh = _section_loft(spec, rgba)
    elif shape == "donor_face_grid_loft":
        mesh = _donor_face_grid_loft(spec, rgba)
    elif shape == "donor_face_surface_loft":
        mesh = _donor_face_surface_loft(spec, rgba)
    elif shape == "cylinder_x":
        mesh = _cylinder(float(spec["radius"]), float(spec["height"]), "x", rgba)
    elif shape == "cylinder_y":
        mesh = _cylinder(float(spec["radius"]), float(spec["height"]), "y", rgba)
    elif shape == "cylinder_z":
        mesh = _cylinder(float(spec["radius"]), float(spec["height"]), "z", rgba)
    elif shape == "face":
        mesh = _face([float(x) for x in spec["scale"]], rgba)
    elif shape == "torus_x":
        mesh = _torus(float(spec["radius"]), float(spec["tube_radius"]), "x", spec.get("scale"), rgba)
    elif shape == "torus_y":
        mesh = _torus(float(spec["radius"]), float(spec["tube_radius"]), "y", spec.get("scale"), rgba)
    elif shape == "torus_z":
        mesh = _torus(float(spec["radius"]), float(spec["tube_radius"]), "z", spec.get("scale"), rgba)
    elif shape == "imported_mesh":
        mesh = _imported_mesh(spec, rgba)
    elif shape == "oem_inflated_hull":
        mesh = _oem_inflated_hull(spec, rgba)
    else:
        raise ValueError(f"unsupported bodykit shape {shape!r}")
    if shape not in {"imported_mesh", "oem_inflated_hull"}:
        if "rotation_euler_deg" in spec:
            rx, ry, rz = [math.radians(float(x)) for x in spec["rotation_euler_deg"]]
            matrix = trimesh.transformations.euler_matrix(rx, ry, rz, axes="sxyz")
            mesh.apply_transform(matrix)
        mesh.apply_translation([float(x) for x in spec["center"]])
    return mesh


def _cq_shape_from_spec(cq: Any, spec: dict[str, Any]) -> Any:
    shape = str(spec["shape"])
    center = tuple(float(x) for x in spec["center"])

    def ellipsoid(scale: list[float]) -> Any:
        sx, sy, sz = [float(x) for x in scale]
        matrix = cq.Matrix(
            [
                [sx, 0, 0, 0],
                [0, sy, 0, 0],
                [0, 0, sz, 0],
                [0, 0, 0, 1],
            ]
        )
        return cq.Workplane("XY").sphere(1).val().transformGeometry(matrix)

    def cylinder(radius: float, height: float, axis: str) -> Any:
        directions = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}
        direction = directions[axis]
        start = tuple(-height / 2 * x for x in direction)
        return cq.Solid.makeCylinder(radius, height, start, direction)

    def capsule(radius: float, height: float, axis: str) -> Any:
        directions = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}
        direction = directions[axis]
        cyl_len = max(height - 2 * radius, radius * 0.1)
        a = tuple(-cyl_len / 2 * x for x in direction)
        b = tuple(cyl_len / 2 * x for x in direction)
        cyl = cq.Solid.makeCylinder(radius, cyl_len, a, direction)
        cap_a = cq.Workplane("XY").sphere(radius).val().translate(a)
        cap_b = cq.Workplane("XY").sphere(radius).val().translate(b)
        return cq.Compound.makeCompound([cyl, cap_a, cap_b])

    if shape == "ellipsoid":
        solid = ellipsoid([float(x) for x in spec["scale"]])
    elif shape == "face":
        scale = [float(x) for x in spec["scale"]]
        head = ellipsoid(scale)
        nose = cq.Solid.makeCone(0.012, 0.0, 0.030, (scale[0] * 0.93 - 0.015, 0, -scale[2] * 0.05), (1, 0, 0))
        cheek_l = ellipsoid([0.012, 0.018, 0.010]).translate(
            (scale[0] * 0.78, scale[1] * 0.35, -scale[2] * 0.12)
        )
        cheek_r = ellipsoid([0.012, 0.018, 0.010]).translate(
            (scale[0] * 0.78, -scale[1] * 0.35, -scale[2] * 0.12)
        )
        solid = cq.Compound.makeCompound([head, nose, cheek_l, cheek_r])
    elif shape == "capsule_z":
        solid = capsule(float(spec["radius"]), float(spec["height"]), "z")
    elif shape == "capsule_x":
        solid = capsule(float(spec["radius"]), float(spec["height"]), "x")
    elif shape == "capsule_y":
        solid = capsule(float(spec["radius"]), float(spec["height"]), "y")
    elif shape == "box":
        sx, sy, sz = [float(x) * 2 for x in spec["scale"]]
        solid = cq.Workplane("XY").box(sx, sy, sz).val()
    elif shape == "tapered_box":
        sx, sy, sz = [float(x) for x in spec["scale"]]
        tx, ty = [float(x) for x in spec["top_scale"][:2]]
        bottom = [(-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)]
        top = [(-tx, -ty), (tx, -ty), (tx, ty), (-tx, ty)]
        solid = (
            cq.Workplane("XY")
            .workplane(offset=-sz)
            .polyline(bottom)
            .close()
            .workplane(offset=2 * sz)
            .polyline(top)
            .close()
            .loft(combine=True)
            .val()
        )
    elif shape == "section_loft":
        axis = str(spec.get("axis", "z"))
        if axis not in AXIS_INDEX:
            raise ValueError("section_loft supports axis: x, y, or z")
        workplane_name = {"x": "YZ", "y": "XZ", "z": "XY"}[axis]
        workplane = None
        for section in spec["sections"]:
            position = float(section.get(axis, section.get("position", section.get("z"))))
            sx, sy = [float(x) for x in section["scale"][:2]]
            ox, oy = [float(x) for x in section.get("offset", [0.0, 0.0])]
            if workplane is None:
                workplane = cq.Workplane(workplane_name).workplane(offset=position).center(ox, oy).ellipse(sx, sy)
            else:
                workplane = workplane.workplane(offset=position - float(prev_position)).center(ox, oy).ellipse(sx, sy)
            prev_position = position
        solid = workplane.loft(combine=True).val()
    elif shape == "donor_face_grid_loft":
        workplane = None
        prev_z = 0.0
        for section in _donor_face_grid_sections(spec):
            points = [(float(x), float(y)) for x, y in section["points"]]
            z = float(section["z"])
            if workplane is None:
                workplane = cq.Workplane("XY").workplane(offset=z).polyline(points).close()
            else:
                workplane = workplane.workplane(offset=z - prev_z).polyline(points).close()
            prev_z = z
        solid = workplane.loft(combine=True).val()
    elif shape == "cylinder_x":
        solid = cylinder(float(spec["radius"]), float(spec["height"]), "x")
    elif shape == "cylinder_y":
        solid = cylinder(float(spec["radius"]), float(spec["height"]), "y")
    elif shape == "cylinder_z":
        solid = cylinder(float(spec["radius"]), float(spec["height"]), "z")
    elif shape == "torus_x":
        solid = cq.Solid.makeTorus(float(spec["radius"]), float(spec["tube_radius"]), (0, 0, 0), (1, 0, 0))
    elif shape == "torus_y":
        solid = cq.Solid.makeTorus(float(spec["radius"]), float(spec["tube_radius"]), (0, 0, 0), (0, 1, 0))
    elif shape == "torus_z":
        solid = cq.Solid.makeTorus(float(spec["radius"]), float(spec["tube_radius"]), (0, 0, 0), (0, 0, 1))
    else:
        raise ValueError(f"unsupported bodykit shape {shape!r}")
    if "rotation_euler_deg" in spec:
        rx, ry, rz = [float(x) for x in spec["rotation_euler_deg"]]
        solid = solid.rotate((0, 0, 0), (1, 0, 0), rx)
        solid = solid.rotate((0, 0, 0), (0, 1, 0), ry)
        solid = solid.rotate((0, 0, 0), (0, 0, 1), rz)
    return solid.translate(center)


def export_step_solids(params: dict[str, Any]) -> dict[str, Any]:
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    if STEP_ROOT.exists():
        shutil.rmtree(STEP_ROOT)
    STEP_ROOT.mkdir(parents=True, exist_ok=True)
    report_path = REVIEW_ROOT / "step-export-report.json"
    try:
        import cadquery as cq
        from cadquery import exporters
    except Exception as exc:
        report = {
            "status": "blocked",
            "reason": f"CadQuery/OCP unavailable: {type(exc).__name__}: {exc}",
            "exported_count": 0,
            "parts": [],
            "tooling_release_gate": "blocked-until-step-solid-and-final-r1-cad",
        }
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        return report

    exported = []
    blocked = []
    for spec in params["parts"]:
        if str(spec["shape"]) in {"imported_mesh", "oem_inflated_hull"} and not spec.get("step_source"):
            blocked.append(
                {
                    "name": str(spec["name"]),
                    "shape": str(spec["shape"]),
                    "status": "blocked",
                    "reason": "mesh-derived source surface needs production CAD rebuild or explicit step_source",
                    "source_asset": str(spec.get("mesh_source", "")),
                    "oem_baseline_meshes": [str(x) for x in spec.get("oem_baseline_meshes", [])],
                }
            )
            continue
        if str(spec["shape"]) in {"imported_mesh", "oem_inflated_hull"}:
            source = _resolve_project_path(str(spec["step_source"]))
            path = STEP_ROOT / f"{spec['name']}.step"
            shutil.copy2(source, path)
            exported.append(
                {
                    "name": str(spec["name"]),
                    "shape": str(spec["shape"]),
                    "step": str(path),
                    "status": "exported-from-source",
                    "source_asset": str(spec.get("mesh_source", "")),
                }
            )
            continue
        path = STEP_ROOT / f"{spec['name']}.step"
        solid = _cq_shape_from_spec(cq, spec)
        exporters.export(cq.Workplane("XY").newObject([solid]), str(path))
        exported.append(
            {
                "name": str(spec["name"]),
                "shape": str(spec["shape"]),
                "step": str(path),
                "status": "exported",
                "note": (
                    "Parametric EVT STEP export from bodykit YAML. Production tooling still "
                    "requires final R1 CAD/scan, shell offsets, mounts, ribs, inserts, "
                    "parting lines, and surface-class review."
                ),
            }
        )
    report = {
        "status": "exported" if not blocked else "partial",
        "cadquery_version": getattr(cq, "__version__", "unknown"),
        "exported_count": len(exported),
        "expected_count": len(params["parts"]),
        "blocked_count": len(blocked),
        "step_root": str(STEP_ROOT),
        "parts": exported,
        "blocked_parts": blocked,
        "tooling_release_gate": "blocked-until-final-r1-cad-and-production-dfm",
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def _asset_mesh_vertices(asset_path: Path) -> np.ndarray:
    loaded = trimesh.load(asset_path, force="mesh")
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError(f"source mesh has no geometry: {asset_path}")
        mesh = trimesh.util.concatenate(meshes)
    else:
        mesh = loaded
    vertices = np.asarray(mesh.vertices, dtype=float)
    if len(vertices) < 8:
        raise ValueError(f"source mesh has too few vertices for reconstruction: {asset_path}")
    return vertices


def _mesh_section_loft_spec(
    asset_path: Path,
    *,
    sections_count: int = 11,
    quantile: float = 0.95,
    min_radius_m: float = 0.002,
    clearance_offset_m: float = 0.0008,
) -> dict[str, Any]:
    vertices = _asset_mesh_vertices(asset_path)
    mins = vertices.min(axis=0)
    maxs = vertices.max(axis=0)
    extents = np.maximum(maxs - mins, 1e-9)
    axis_index = int(np.argmax(extents))
    axis = ["x", "y", "z"][axis_index]
    cross_axes = [i for i in range(3) if i != axis_index]
    lo = float(mins[axis_index])
    hi = float(maxs[axis_index])
    positions = np.linspace(lo, hi, sections_count)
    slab = max((hi - lo) / max(sections_count - 1, 1) * 0.72, 1e-5)
    sections: list[dict[str, Any]] = []
    last_center = vertices[:, cross_axes].mean(axis=0)
    last_radius = np.maximum(np.percentile(np.abs(vertices[:, cross_axes] - last_center), quantile * 100.0, axis=0), min_radius_m)
    for pos in positions:
        mask = np.abs(vertices[:, axis_index] - pos) <= slab
        local = vertices[mask]
        if len(local) < 12:
            nearest = np.argsort(np.abs(vertices[:, axis_index] - pos))[: min(96, len(vertices))]
            local = vertices[nearest]
        center = np.median(local[:, cross_axes], axis=0)
        radius = np.quantile(np.abs(local[:, cross_axes] - center), quantile, axis=0) + clearance_offset_m
        radius = np.maximum(radius, min_radius_m)
        last_center = center
        last_radius = radius
        sections.append(
            {
                "position": round(float(pos), 6),
                "center": [round(float(x), 6) for x in center],
                "radius": [round(float(x), 6) for x in radius],
                "sample_count": int(len(local)),
            }
        )
    return {
        "asset": asset_path.name,
        "source": str(asset_path),
        "source_kind": "stl_mesh_reference",
        "reconstruction_kind": "parametric_mesh_section_loft",
        "axis": axis,
        "axis_index": axis_index,
        "cross_axis_indices": cross_axes,
        "sections_count": len(sections),
        "fit_quantile": quantile,
        "clearance_offset_m": clearance_offset_m,
        "bbox_m": {
            "min": [round(float(x), 6) for x in mins],
            "max": [round(float(x), 6) for x in maxs],
            "extents": [round(float(x), 6) for x in extents],
        },
        "sections": sections,
        "fallback_section": {
            "center": [round(float(x), 6) for x in last_center],
            "radius": [round(float(x), 6) for x in last_radius],
        },
    }


def _cq_solid_from_mesh_section_loft(cq: Any, spec: dict[str, Any]) -> Any:
    axis = str(spec["axis"])
    axis_index = AXIS_INDEX[axis]
    cross_axes = [int(x) for x in spec["cross_axis_indices"]]
    workplane_name = {"x": "YZ", "y": "XZ", "z": "XY"}[axis]
    workplane = None
    prev_position = 0.0
    for section in spec["sections"]:
        position = float(section["position"])
        c0, c1 = [float(x) for x in section["center"]]
        r0, r1 = [float(x) for x in section["radius"]]
        if workplane is None:
            workplane = cq.Workplane(workplane_name).workplane(offset=position).center(c0, c1).ellipse(r0, r1)
        else:
            workplane = workplane.workplane(offset=position - prev_position).center(c0, c1).ellipse(r0, r1)
        prev_position = position
    return workplane.loft(combine=True).val()


def export_base_asset_reconstructions(params: dict[str, Any]) -> dict[str, Any]:
    """Rebuild STL-only R1 assets as parametric loft STEP references.

    These are not official Unitree source CAD. They are deterministic, editable
    section-loft approximations from the MJCF STL meshes, intended as the first
    CAD reconstruction layer for mounts, envelopes, offsets, and future morphs.
    """
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    if BASE_RECON_ROOT.exists():
        shutil.rmtree(BASE_RECON_ROOT)
    BASE_RECON_STEP_ROOT.mkdir(parents=True, exist_ok=True)
    BASE_RECON_PARAM_ROOT.mkdir(parents=True, exist_ok=True)
    report_path = REVIEW_ROOT / "base-cad-reconstruction-report.json"
    stl_assets = sorted([p for p in R1_ASSET_ROOT.iterdir() if p.suffix.lower() == ".stl"], key=lambda p: p.name.lower())
    try:
        import cadquery as cq
        from cadquery import exporters
    except Exception as exc:
        report = {
            "verdict": "blocked",
            "source": "unitree-r1 MJCF STL assets",
            "source_asset_root": str(R1_ASSET_ROOT),
            "official_step_source_available": False,
            "reason": f"CadQuery/OCP unavailable: {type(exc).__name__}: {exc}",
            "asset_count": len(stl_assets),
            "reconstructed_count": 0,
            "failed_count": len(stl_assets),
            "assets": [],
        }
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        return report

    reconstructed = []
    failed = []
    for asset_path in stl_assets:
        try:
            spec = _mesh_section_loft_spec(asset_path)
            solid = _cq_solid_from_mesh_section_loft(cq, spec)
            step_path = BASE_RECON_STEP_ROOT / f"{asset_path.stem}.step"
            param_path = BASE_RECON_PARAM_ROOT / f"{asset_path.stem}.json"
            exporters.export(cq.Workplane("XY").newObject([solid]), str(step_path))
            param_path.write_text(json.dumps(spec, indent=2) + "\n")
            reconstructed.append(
                {
                    "asset": asset_path.name,
                    "status": "reconstructed",
                    "source_kind": spec["source_kind"],
                    "reconstruction_kind": spec["reconstruction_kind"],
                    "axis": spec["axis"],
                    "sections_count": spec["sections_count"],
                    "bbox_m": spec["bbox_m"],
                    "step": str(step_path),
                    "parameters": str(param_path),
                }
            )
        except Exception as exc:
            failed.append({"asset": asset_path.name, "status": "failed", "reason": f"{type(exc).__name__}: {exc}"})
    report = {
        "verdict": "pass" if not failed else "needs-work",
        "source": "unitree-r1 MJCF STL assets",
        "source_asset_root": str(R1_ASSET_ROOT),
        "official_step_source_available": False,
        "official_step_source_note": (
            "No official Unitree R1 STEP/CAD files are present in this repository. "
            "These outputs are parametric reconstructions from STL mesh references."
        ),
        "asset_count": len(stl_assets),
        "reconstructed_count": len(reconstructed),
        "failed_count": len(failed),
        "step_root": str(BASE_RECON_STEP_ROOT),
        "parameter_root": str(BASE_RECON_PARAM_ROOT),
        "method": {
            "kind": "fixed-axis elliptical section loft",
            "sections_count": 11,
            "fit_quantile": 0.95,
            "clearance_offset_m": 0.0008,
            "usage": "base chassis envelope CAD for mount/offset/gap planning; not a final mechanical-source replacement",
        },
        "assets": reconstructed,
        "failed_assets": failed,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def generate_meshes(params: dict[str, Any]) -> list[Part]:
    MESH_ROOT.mkdir(parents=True, exist_ok=True)
    materials = params["materials"]
    parts: list[Part] = []
    for spec in params["parts"]:
        material = str(spec["material"])
        rgba = [float(x) for x in materials[material]["color_rgba"]]
        mesh = _part_mesh(spec, rgba)
        mesh.metadata.update(
            {
                "name": spec["name"],
                "body": spec["body"],
                "role": spec["role"],
                "material": material,
                "source_kind": str(spec.get("source_kind", "primitive")),
                "source_asset": str(spec.get("mesh_source", "")) if spec.get("mesh_source") else None,
                "oem_baseline_meshes": list(spec.get("oem_baseline_meshes", [])),
            }
        )
        stl_path = MESH_ROOT / f"{spec['name']}.stl"
        obj_path = MESH_ROOT / f"{spec['name']}.obj"
        mesh.export(stl_path)
        mesh.export(obj_path)
        parts.append(
            Part(
                name=str(spec["name"]),
                body=str(spec["body"]),
                role=str(spec["role"]),
                material=material,
                source_kind=str(spec.get("source_kind", "primitive")),
                source_asset=str(spec.get("mesh_source", "")) if spec.get("mesh_source") else None,
                oem_baseline_meshes=tuple(str(x) for x in spec.get("oem_baseline_meshes", [])),
                mesh=mesh,
                stl_path=stl_path,
                obj_path=obj_path,
            )
        )
    return parts


def _indent(elem: ET.Element, level: int = 0) -> None:
    space = "\n" + level * "  "
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = space + "  "
        for child in elem:
            _indent(child, level + 1)
        if not child.tail or not child.tail.strip():
            child.tail = space
    if level and (not elem.tail or not elem.tail.strip()):
        elem.tail = space


def _body_map(root: ET.Element) -> dict[str, ET.Element]:
    out: dict[str, ET.Element] = {}
    for body in root.iter("body"):
        name = body.attrib.get("name")
        if name:
            out[name] = body
    return out


def _write_bodykit_mjcf_variant(params: dict[str, Any], parts: list[Part], *, collision_enabled: bool) -> Path:
    MJCF_ROOT.mkdir(parents=True, exist_ok=True)
    base_mjcf = PKG_ROOT / "assets" / "profiles" / "unitree-r1" / "mjcf" / "R1_C++.xml"
    output = MJCF_ROOT / ("R1_C++_bodykit_collision_test.xml" if collision_enabled else "R1_C++_bodykit.xml")

    assets_dir = MJCF_ROOT / "assets"
    if assets_dir.exists() and not collision_enabled:
        shutil.rmtree(assets_dir)
    if not assets_dir.exists():
        shutil.copytree(base_mjcf.parent / "assets", assets_dir)
    bodykit_dir = assets_dir / "bodykit"
    bodykit_dir.mkdir(parents=True, exist_ok=True)
    for part in parts:
        shutil.copy2(part.stl_path, bodykit_dir / part.stl_path.name)

    tree = ET.parse(base_mjcf)
    root = tree.getroot()
    asset = root.find("asset")
    if asset is None:
        asset = ET.SubElement(root, "asset")

    for material_name, material in params["materials"].items():
        rgba = " ".join(str(float(x)) for x in material["color_rgba"])
        ET.SubElement(asset, "material", {"name": f"bodykit_{material_name}", "rgba": rgba})
    for part in parts:
        ET.SubElement(
            asset,
            "mesh",
            {"name": f"bodykit_{part.name}", "file": f"bodykit/{part.name}.stl"},
        )

    bodies = _body_map(root)
    for part in parts:
        if part.body not in bodies:
            raise ValueError(f"bodykit part {part.name} references missing body {part.body}")
        ET.SubElement(
            bodies[part.body],
            "geom",
            {
                "name": f"bodykit_{part.name}",
                "type": "mesh",
                "mesh": f"bodykit_{part.name}",
                "material": f"bodykit_{part.material}",
                "contype": "1" if collision_enabled else "0",
                "conaffinity": "1" if collision_enabled else "0",
                "group": "2",
                "density": "0",
            },
        )

    worldbody = root.find("worldbody")
    if worldbody is not None:
        cameras = {
            "bodykit_front": "3.0 0.0 1.15",
            "bodykit_rear": "-3.0 0.0 1.15",
            "bodykit_left": "0.1 3.0 1.15",
            "bodykit_right": "0.1 -3.0 1.15",
            "bodykit_head": "1.15 0.0 1.24",
        }
        for name, pos in cameras.items():
            ET.SubElement(
                worldbody,
                "camera",
                {
                    "name": name,
                    "mode": "targetbody",
                    "target": "torso_link",
                    "pos": pos,
                    "fovy": "35",
                },
            )

    _indent(root)
    tree.write(output, encoding="utf-8", xml_declaration=False)
    return output


def write_bodykit_mjcf(params: dict[str, Any], parts: list[Part]) -> Path:
    visual_mjcf = _write_bodykit_mjcf_variant(params, parts, collision_enabled=False)
    _write_bodykit_mjcf_variant(params, parts, collision_enabled=True)
    return visual_mjcf


def _set_home_pose(model: mujoco.MjModel, data: mujoco.MjData, params: dict[str, Any]) -> None:
    qpos_i = 7
    for part in params.get("profile_joints", []):
        _ = part
    # The public R1 model has no keyframe. Zero joint pose is the documented
    # neutral compile pose, so only the freejoint root needs to be normalized.
    data.qpos[:] = 0
    data.qpos[2] = 0.74
    data.qpos[3] = 1.0
    if model.nq > qpos_i:
        data.qpos[qpos_i:] = 0
    mujoco.mj_forward(model, data)


def _actuated_joint_ids(model: mujoco.MjModel) -> list[int]:
    joint_ids: list[int] = []
    seen: set[int] = set()
    for actuator_id in range(model.nu):
        joint_id = int(model.actuator_trnid[actuator_id, 0])
        if joint_id >= 0 and joint_id not in seen:
            joint_ids.append(joint_id)
            seen.add(joint_id)
    return joint_ids


def _set_joint_pose(model: mujoco.MjModel, data: mujoco.MjData, joint_values: dict[int, float]) -> None:
    _set_home_pose(model, data, {})
    for joint_id, value in joint_values.items():
        qadr = int(model.jnt_qposadr[joint_id])
        data.qpos[qadr] = value
    mujoco.mj_forward(model, data)


def _joint_extreme_value(model: mujoco.MjModel, joint_name: str, side: str, fraction: float) -> tuple[int, float]:
    joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint_name)
    if joint_id < 0:
        raise ValueError(f"missing joint {joint_name}")
    lower, upper = [float(x) for x in model.jnt_range[joint_id]]
    midpoint = (lower + upper) / 2
    if side == "low":
        return joint_id, midpoint + (lower - midpoint) * fraction
    if side == "high":
        return joint_id, midpoint + (upper - midpoint) * fraction
    raise ValueError(f"unsupported joint side {side!r}")


def _set_named_joint_pose(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    specs: list[tuple[str, str, float]],
) -> None:
    values = {}
    for joint_name, side, fraction in specs:
        joint_id, value = _joint_extreme_value(model, joint_name, side, fraction)
        values[joint_id] = value
    _set_joint_pose(model, data, values)


def _body_world_mesh(model: mujoco.MjModel, data: mujoco.MjData, body_name: str, mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, body_name)
    if body_id < 0:
        raise ValueError(f"missing body {body_name}")
    mat = np.eye(4)
    mat[:3, :3] = data.xmat[body_id].reshape(3, 3)
    mat[:3, 3] = data.xpos[body_id]
    world = mesh.copy()
    world.apply_transform(mat)
    return world


def _primitive_surface_points(geom_type: str, size: np.ndarray) -> np.ndarray:
    if geom_type == "box":
        mesh = trimesh.creation.box(extents=np.maximum(size[:3] * 2, 1e-4))
        return np.asarray(mesh.vertices)
    if geom_type == "sphere":
        mesh = trimesh.creation.uv_sphere(radius=max(float(size[0]), 1e-4), segments=16, ring_count=8)
        return np.asarray(mesh.vertices)
    if geom_type == "cylinder":
        mesh = trimesh.creation.cylinder(radius=max(float(size[0]), 1e-4), height=max(float(size[1]) * 2, 1e-4), sections=24)
        return np.asarray(mesh.vertices)
    if geom_type == "capsule":
        mesh = trimesh.creation.capsule(radius=max(float(size[0]), 1e-4), height=max(float(size[1]) * 2, 1e-4), count=[16, 8])
        return np.asarray(mesh.vertices)
    return np.zeros((1, 3), dtype=float)


def _geom_surface_points(model: mujoco.MjModel, data: mujoco.MjData, geom_id: int) -> np.ndarray:
    geom_type = _geom_type_name(model, geom_id)
    if geom_type == "mesh":
        mesh_id = int(model.geom_dataid[geom_id])
        start = int(model.mesh_vertadr[mesh_id])
        count = int(model.mesh_vertnum[mesh_id])
        local = np.asarray(model.mesh_vert[start : start + count])
    else:
        local = _primitive_surface_points(geom_type, np.asarray(model.geom_size[geom_id]))
    rot = data.geom_xmat[geom_id].reshape(3, 3)
    pos = data.geom_xpos[geom_id]
    return local @ rot.T + pos


def _surface_cloud(
    model: mujoco.MjModel, data: mujoco.MjData, geom_ids: list[int]
) -> tuple[np.ndarray, list[int]] | None:
    clouds = []
    ids: list[int] = []
    for geom_id in geom_ids:
        pts = _geom_surface_points(model, data, geom_id)
        if len(pts):
            if len(pts) > 320:
                pts = pts[np.linspace(0, len(pts) - 1, 320, dtype=int)]
            clouds.append(pts)
            ids.extend([geom_id] * len(pts))
    if not clouds:
        return None
    return np.vstack(clouds), ids


def _deterministic_mesh_surface_points(mesh: trimesh.Trimesh, limit: int = 220) -> np.ndarray:
    vertices = np.asarray(mesh.vertices, dtype=float)
    if len(mesh.faces):
        triangles = vertices[np.asarray(mesh.faces, dtype=int)]
        centroids = triangles.mean(axis=1)
        points = np.concatenate([vertices, centroids], axis=0)
    else:
        points = vertices
    if len(points) > limit:
        points = points[np.linspace(0, len(points) - 1, limit, dtype=int)]
    return points


def _body_tree_distance(model: mujoco.MjModel, body_a: int, body_b: int) -> int | None:
    if body_a == body_b:
        return 0
    parents = [int(model.body_parentid[i]) for i in range(model.nbody)]
    frontier = [(body_a, 0)]
    seen = {body_a}
    while frontier:
        body_id, distance = frontier.pop(0)
        neighbors = []
        parent = parents[body_id]
        if parent >= 0 and parent != body_id:
            neighbors.append(parent)
        neighbors.extend(i for i, p in enumerate(parents) if p == body_id and i != body_id)
        for neighbor in neighbors:
            if neighbor == body_b:
                return distance + 1
            if neighbor not in seen:
                seen.add(neighbor)
                frontier.append((neighbor, distance + 1))
    return None


def _sample_shell_clearance(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    parts: list[Part],
    base_geom_ids: list[int],
    *,
    ignore_mounted_body: bool,
    min_body_tree_distance: int | None = None,
) -> tuple[float, dict[str, float], int, dict[str, Any] | None]:
    body_ids = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i): i for i in range(model.nbody)}
    min_bodykit_to_base = float("inf")
    samples_checked = 0
    per_part: dict[str, float] = {}
    worst: dict[str, Any] | None = None
    tree_cache: dict[tuple[int, ...], tuple[cKDTree, np.ndarray, list[int]]] = {}
    for part in parts:
        mounted_body_id = body_ids[part.body]
        world_mesh = _body_world_mesh(model, data, part.body, part.mesh)
        pts = _deterministic_mesh_surface_points(world_mesh)
        candidate_geom_ids = [
            geom_id
            for geom_id in base_geom_ids
            if not ignore_mounted_body or int(model.geom_bodyid[geom_id]) != mounted_body_id
            if min_body_tree_distance is None
            or (
                (distance := _body_tree_distance(model, mounted_body_id, int(model.geom_bodyid[geom_id])))
                is not None
                and distance > min_body_tree_distance
            )
        ]
        if not candidate_geom_ids:
            continue
        cache_key = tuple(candidate_geom_ids)
        cached = tree_cache.get(cache_key)
        if cached is None:
            cloud = _surface_cloud(model, data, candidate_geom_ids)
            if cloud is None:
                continue
            cloud_points, cloud_geom_ids = cloud
            cached = (cKDTree(cloud_points), cloud_points, cloud_geom_ids)
            tree_cache[cache_key] = cached
        tree, cloud_points, cloud_geom_ids = cached
        min_part = float("inf")
        distances, indexes = tree.query(pts, k=1)
        nearest_index = int(np.argmin(distances))
        nearest_cloud_index = int(indexes[nearest_index])
        min_part = min(min_part, float(distances[nearest_index]))
        nearest_geom_id = int(cloud_geom_ids[nearest_cloud_index])
        part_sample_point = np.asarray(pts[nearest_index], dtype=float)
        base_sample_point = np.asarray(cloud_points[nearest_cloud_index], dtype=float)
        delta_vector = base_sample_point - part_sample_point
        samples_checked += len(pts)
        per_part[part.name] = min_part
        if min_part < min_bodykit_to_base:
            min_bodykit_to_base = min_part
            base_geom_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, nearest_geom_id)
            base_body_name = mujoco.mj_id2name(
                model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[nearest_geom_id])
            )
            base_body_id = int(model.geom_bodyid[nearest_geom_id])
            worst = {
                "part": part.name,
                "part_body": part.body,
                "base_geom": base_geom_name or f"geom_{nearest_geom_id}",
                "base_body": base_body_name or f"body_{base_body_id}",
                "base_geom_type": _geom_type_name(model, nearest_geom_id),
                "body_tree_distance": _body_tree_distance(model, mounted_body_id, base_body_id),
                "clearance_mm": round(min_part * 1000, 3),
                "part_sample_point_m": np.round(part_sample_point, 5).tolist(),
                "base_sample_point_m": np.round(base_sample_point, 5).tolist(),
                "part_to_base_vector_m": np.round(delta_vector, 5).tolist(),
                "part_to_base_vector_mm": np.round(delta_vector * 1000, 3).tolist(),
            }
    return min_bodykit_to_base, per_part, samples_checked, worst


def _joint_sweep_report(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    parts: list[Part],
    base_geom_ids: list[int],
    *,
    articulated_body_distance: int,
    sweep_fraction: float,
    label: str,
) -> dict[str, Any]:
    joint_ids = _actuated_joint_ids(model)
    poses: list[tuple[str, dict[int, float]]] = [("home", {})]
    joint_extremes: dict[str, tuple[int, float, float]] = {}
    for joint_id in joint_ids:
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id) or f"joint_{joint_id}"
        qadr = int(model.jnt_qposadr[joint_id])
        limited = bool(model.jnt_limited[joint_id])
        if qadr < 7 or not limited:
            continue
        lower, upper = [float(x) for x in model.jnt_range[joint_id]]
        if upper <= lower or abs(upper - lower) < 0.05:
            continue
        midpoint = (lower + upper) / 2
        lo = midpoint + (lower - midpoint) * sweep_fraction
        hi = midpoint + (upper - midpoint) * sweep_fraction
        joint_extremes[name] = (joint_id, lo, hi)
        poses.append((f"{name}_low", {joint_id: lo}))
        poses.append((f"{name}_high", {joint_id: hi}))

    combined_specs = [
        ("left_hip_yaw_joint", "left_knee_joint"),
        ("right_hip_yaw_joint", "right_knee_joint"),
        ("left_hip_roll_joint", "left_knee_joint"),
        ("right_hip_roll_joint", "right_knee_joint"),
        ("left_shoulder_pitch_joint", "left_elbow_joint"),
        ("right_shoulder_pitch_joint", "right_elbow_joint"),
        ("left_shoulder_roll_joint", "left_elbow_joint"),
        ("right_shoulder_roll_joint", "right_elbow_joint"),
        ("waist_yaw_joint", "left_shoulder_pitch_joint"),
        ("waist_yaw_joint", "right_shoulder_pitch_joint"),
    ]
    for a_name, b_name in combined_specs:
        if a_name not in joint_extremes or b_name not in joint_extremes:
            continue
        a_id, a_lo, a_hi = joint_extremes[a_name]
        b_id, b_lo, b_hi = joint_extremes[b_name]
        poses.append((f"{a_name}_low__{b_name}_low", {a_id: a_lo, b_id: b_lo}))
        poses.append((f"{a_name}_high__{b_name}_high", {a_id: a_hi, b_id: b_hi}))

    min_clearance = float("inf")
    min_non_adjacent_clearance = float("inf")
    worst_pose = None
    worst_non_adjacent_pose = None
    pose_results: list[dict[str, Any]] = []
    samples = 0
    for pose_name, values in poses:
        _set_joint_pose(model, data, values)
        clear, per_part, checked, worst = _sample_shell_clearance(
            model, data, parts, base_geom_ids, ignore_mounted_body=True
        )
        non_adjacent_clear, non_adjacent_per_part, non_adjacent_checked, non_adjacent_worst = (
            _sample_shell_clearance(
                model,
                data,
                parts,
                base_geom_ids,
                ignore_mounted_body=True,
                min_body_tree_distance=articulated_body_distance,
            )
        )
        samples += checked
        clear_mm = clear * 1000
        non_adjacent_clear_mm = non_adjacent_clear * 1000
        if clear < min_clearance:
            min_clearance = clear
            worst_pose = pose_name
        if non_adjacent_clear < min_non_adjacent_clearance:
            min_non_adjacent_clearance = non_adjacent_clear
            worst_non_adjacent_pose = pose_name
        pose_results.append(
            {
                "pose": pose_name,
                "minimum_non_mounted_clearance_mm": round(clear_mm, 3),
                "worst_part": min(per_part, key=per_part.get) if per_part else None,
                "worst_clearance": worst,
                "minimum_non_adjacent_clearance_mm": round(non_adjacent_clear_mm, 3),
                "worst_non_adjacent_part": (
                    min(non_adjacent_per_part, key=non_adjacent_per_part.get)
                    if non_adjacent_per_part
                    else None
                ),
                "worst_non_adjacent_clearance": non_adjacent_worst,
                "non_adjacent_samples_checked": non_adjacent_checked,
            }
        )
    return {
        "poses_checked": len(poses),
        "label": label,
        "sweep_fraction": sweep_fraction,
        "samples_checked": samples,
        "minimum_non_mounted_clearance_mm": round(min_clearance * 1000, 3),
        "worst_pose": worst_pose,
        "minimum_non_adjacent_clearance_mm": round(min_non_adjacent_clearance * 1000, 3),
        "worst_non_adjacent_pose": worst_non_adjacent_pose,
        "articulated_body_distance": articulated_body_distance,
        "pose_results": pose_results,
    }


def validate_fit(params: dict[str, Any], mjcf_path: Path, parts: list[Part]) -> dict[str, Any]:
    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    _set_home_pose(model, data, params)

    geom_names = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or "" for i in range(model.ngeom)]
    base_geom_ids = [
        i
        for i, name in enumerate(geom_names)
        if not name.startswith("bodykit_")
        and (int(model.geom_contype[i]) != 0 or int(model.geom_conaffinity[i]) != 0)
    ]
    shell_geom_ids = [i for i, name in enumerate(geom_names) if name.startswith("bodykit_")]

    min_bodykit_to_base, per_part, samples_checked, worst_home = _sample_shell_clearance(
        model, data, parts, base_geom_ids, ignore_mounted_body=False
    )
    min_non_mounted, per_part_non_mounted, non_mounted_samples, worst_non_mounted = _sample_shell_clearance(
        model, data, parts, base_geom_ids, ignore_mounted_body=True
    )
    articulated_body_distance = int(params.get("fit", {}).get("articulated_body_distance", 3))
    (
        min_non_adjacent,
        per_part_non_adjacent,
        non_adjacent_samples,
        worst_non_adjacent,
    ) = _sample_shell_clearance(
        model,
        data,
        parts,
        base_geom_ids,
        ignore_mounted_body=True,
        min_body_tree_distance=articulated_body_distance,
    )
    mechanical_sweep_fraction = float(params["fit"].get("mechanical_sweep_fraction", 0.65))
    operating_sweep_fraction = float(params["fit"].get("operating_sweep_fraction", mechanical_sweep_fraction))
    mechanical_sweep = _joint_sweep_report(
        model,
        data,
        parts,
        base_geom_ids,
        articulated_body_distance=articulated_body_distance,
        sweep_fraction=mechanical_sweep_fraction,
        label="mechanical",
    )
    operating_sweep = _joint_sweep_report(
        model,
        data,
        parts,
        base_geom_ids,
        articulated_body_distance=articulated_body_distance,
        sweep_fraction=operating_sweep_fraction,
        label="bodykit_operating",
    )

    # Visual bodykit geoms are deliberately non-contacting. This simulation
    # check confirms the model steps cleanly and reports whether base collisions
    # are already present in the neutral pose.
    data.ctrl[:] = 0
    for _ in range(50):
        mujoco.mj_step(model, data)
    bodykit_contact_count = 0
    for i in range(data.ncon):
        c = data.contact[i]
        if c.geom1 in shell_geom_ids or c.geom2 in shell_geom_ids:
            bodykit_contact_count += 1

    clear_mm = min_bodykit_to_base * 1000
    non_mounted_clear_mm = min_non_mounted * 1000
    non_adjacent_clear_mm = min_non_adjacent * 1000
    required_mm = float(params["fit"]["nominal_chassis_clearance_mm"])
    dynamic_required_mm = float(params["fit"]["dynamic_joint_clearance_mm"])
    collision_test_mjcf = MJCF_ROOT / "R1_C++_bodykit_collision_test.xml"
    collision_model_loads = False
    collision_variant_bodykit_contacts = None
    if collision_test_mjcf.is_file():
        collision_model = mujoco.MjModel.from_xml_path(str(collision_test_mjcf))
        collision_data = mujoco.MjData(collision_model)
        _set_home_pose(collision_model, collision_data, params)
        collision_model_loads = True
        collision_names = [
            mujoco.mj_id2name(collision_model, mujoco.mjtObj.mjOBJ_GEOM, i) or ""
            for i in range(collision_model.ngeom)
        ]
        collision_shell_ids = [i for i, name in enumerate(collision_names) if name.startswith("bodykit_")]
        mujoco.mj_step(collision_model, collision_data)
        collision_variant_bodykit_contacts = 0
        for i in range(collision_data.ncon):
            c = collision_data.contact[i]
            if c.geom1 in collision_shell_ids or c.geom2 in collision_shell_ids:
                collision_variant_bodykit_contacts += 1

    simulator_verdict = "pass" if bodykit_contact_count == 0 and collision_model_loads else "needs-work"
    clearance_verdict = (
        "pass"
        if non_adjacent_clear_mm >= required_mm
        and operating_sweep["minimum_non_adjacent_clearance_mm"] >= dynamic_required_mm
        else "needs-work"
    )
    # The decorative shell is allowed to envelop its own mounted link because
    # the generated mesh is the cosmetic outer surface, not the inner hollowed
    # wall. The hard gate is simulator load/step health plus no broadphase
    # interference with non-mounted links through representative joint sweeps.
    verdict = "pass" if simulator_verdict == "pass" and clearance_verdict == "pass" else "needs-work"
    report = {
        "verdict": verdict,
        "simulator_verdict": simulator_verdict,
        "clearance_verdict": clearance_verdict,
        "production_fit_verdict": clearance_verdict,
        "mjcf": str(mjcf_path),
        "collision_test_mjcf": str(collision_test_mjcf),
        "nu": int(model.nu),
        "nq": int(model.nq),
        "bodykit_parts": len(parts),
        "bodykit_geoms_are_visual_only": True,
        "bodykit_contact_count": bodykit_contact_count,
        "collision_test_model_loads": collision_model_loads,
        "collision_variant_bodykit_contact_count": collision_variant_bodykit_contacts,
        "samples_checked": samples_checked,
        "minimum_bodykit_to_base_clearance_mm": round(clear_mm, 3),
        "worst_bodykit_to_base_clearance": worst_home,
        "required_nominal_clearance_mm": required_mm,
        "sampled_clearance_is_advisory": False,
        "minimum_non_mounted_body_clearance_mm": round(non_mounted_clear_mm, 3),
        "worst_non_mounted_body_clearance": worst_non_mounted,
        "articulated_body_distance": articulated_body_distance,
        "minimum_non_adjacent_body_clearance_mm": round(non_adjacent_clear_mm, 3),
        "worst_non_adjacent_body_clearance": worst_non_adjacent,
        "required_dynamic_clearance_mm": dynamic_required_mm,
        "non_mounted_samples_checked": non_mounted_samples,
        "non_adjacent_samples_checked": non_adjacent_samples,
        "clearance_sampling": "deterministic_vertices_and_face_centroids",
        "dynamic_joint_sweep": operating_sweep,
        "mechanical_dynamic_joint_sweep": mechanical_sweep,
        "per_part_clearance_mm": {k: round(v * 1000, 3) for k, v in sorted(per_part.items())},
        "per_part_non_mounted_clearance_mm": {
            k: round(v * 1000, 3) for k, v in sorted(per_part_non_mounted.items())
        },
        "per_part_non_adjacent_clearance_mm": {
            k: round(v * 1000, 3) for k, v in sorted(per_part_non_adjacent.items())
        },
        "base_collision_geoms": [
            {
                "name": geom_names[i],
                "body": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, int(model.geom_bodyid[i])),
                "type": _geom_type_name(model, i),
                "rbound_m": round(float(model.geom_rbound[i]), 5),
            }
            for i in base_geom_ids
        ],
        "note": (
            "Same-link shell overlap is expected because generated meshes are cosmetic outer surfaces. "
            "Adjacent kinematic interfaces are reported separately from non-adjacent production clearance. "
            "Non-adjacent body clearance and joint sweep checks are hard gates for production fit. "
            "The primary MJCF keeps bodykit geoms visual-only; the collision-test MJCF enables contacts "
            "for MuJoCo inspection but uses unreduced cosmetic meshes, not final collision proxies. "
            "Production release still needs CAD boolean checks against final R1 CAD/scan."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "fit-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def write_face_alignment_report(
    params: dict[str, Any], parts: list[Part], fit: dict[str, Any], mjcf_path: Path | None = None
) -> dict[str, Any]:
    part_by_name = {part.name: part for part in parts}
    spec_by_name = {str(spec["name"]): spec for spec in params["parts"]}
    face = part_by_name["face_shell"]
    bounds = np.asarray(face.mesh.bounds, dtype=float)
    extents = np.asarray(face.mesh.extents, dtype=float)
    top_z = float(bounds[1, 2])
    depth_x = float(extents[0])
    height_z = float(extents[2])
    width_y = float(extents[1])

    left_eye = spec_by_name["left_eye_insert"]
    right_eye = spec_by_name["right_eye_insert"]
    lip = spec_by_name["lip_insert"]
    left_eye_center = np.asarray(left_eye["center"], dtype=float)
    right_eye_center = np.asarray(right_eye["center"], dtype=float)
    lip_center = np.asarray(lip["center"], dtype=float)
    left_eye_scale = np.asarray(left_eye["scale"], dtype=float)
    right_eye_scale = np.asarray(right_eye["scale"], dtype=float)
    lip_scale = np.asarray(lip["scale"], dtype=float)

    metrics = {
        "face_height_to_width_yz": height_z / width_y,
        "eye_span_to_face_width": abs(float(left_eye_center[1] - right_eye_center[1])) / width_y,
        "eye_center_down_from_face_top": (top_z - float((left_eye_center[2] + right_eye_center[2]) / 2)) / height_z,
        "eye_width_to_face_width": float((left_eye_scale[1] + right_eye_scale[1])) / width_y,
        "mouth_center_down_from_face_top": (top_z - float(lip_center[2])) / height_z,
        "mouth_width_to_face_width": float(lip_scale[1] * 2) / width_y,
    }
    targets = params.get("style", {}).get("face_alignment_targets", {})
    tolerance = float(targets.get("tolerance", 0.08))
    min_face_depth_mm = float(targets.get("min_face_depth_mm", 0.0))
    face_depth_mm = depth_x * 1000
    face_depth_check = {
        "actual_mm": round(face_depth_mm, 3),
        "minimum_mm": round(min_face_depth_mm, 3),
        "within_tolerance": face_depth_mm >= min_face_depth_mm,
            "reason": (
                "Prevents stress-driven over-flattening of the donor-derived parametric face "
                "while 2D face proportions still pass."
            ),
    }
    comparisons = {}
    for key, value in metrics.items():
        target = targets.get(key)
        if target is None:
            continue
        delta = float(value) - float(target)
        comparisons[key] = {
            "actual": round(float(value), 4),
            "target": round(float(target), 4),
            "delta": round(delta, 4),
            "within_tolerance": abs(delta) <= tolerance,
        }

    scoped_names = ["head_mount_neck_black", "face_shell", "left_eye_insert", "right_eye_insert", "lip_insert"]
    per_part_clearance = {
        name: {
            "bodykit_to_base_mm": fit.get("per_part_clearance_mm", {}).get(name),
            "non_mounted_mm": fit.get("per_part_non_mounted_clearance_mm", {}).get(name),
            "non_adjacent_mm": fit.get("per_part_non_adjacent_clearance_mm", {}).get(name),
        }
        for name in scoped_names
    }
    scoped_sweep = None
    if mjcf_path is not None and mjcf_path.is_file():
        model = mujoco.MjModel.from_xml_path(str(mjcf_path))
        data = mujoco.MjData(model)
        _set_home_pose(model, data, params)
        geom_names = [
            mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or ""
            for i in range(model.ngeom)
        ]
        base_geom_ids = [
            i
            for i, name in enumerate(geom_names)
            if not name.startswith("bodykit_")
            and (int(model.geom_contype[i]) != 0 or int(model.geom_conaffinity[i]) != 0)
        ]
        scoped_parts = [part for part in parts if part.name in scoped_names]
        _, scoped_all, _, _ = _sample_shell_clearance(
            model, data, scoped_parts, base_geom_ids, ignore_mounted_body=False
        )
        _, scoped_non_mounted, _, _ = _sample_shell_clearance(
            model, data, scoped_parts, base_geom_ids, ignore_mounted_body=True
        )
        _, scoped_non_adjacent, _, _ = _sample_shell_clearance(
            model,
            data,
            scoped_parts,
            base_geom_ids,
            ignore_mounted_body=True,
            min_body_tree_distance=int(params.get("fit", {}).get("articulated_body_distance", 3)),
        )
        scoped_sweep = _joint_sweep_report(
            model,
            data,
            scoped_parts,
            base_geom_ids,
            articulated_body_distance=int(params.get("fit", {}).get("articulated_body_distance", 3)),
            sweep_fraction=float(params.get("fit", {}).get("operating_sweep_fraction", 0.25)),
            label="neck_head_face_operating",
        )
        for name in scoped_names:
            if name not in per_part_clearance:
                continue
            if name in scoped_all:
                per_part_clearance[name]["bodykit_to_base_mm"] = round(float(scoped_all[name]) * 1000, 3)
            if name in scoped_non_mounted:
                per_part_clearance[name]["non_mounted_mm"] = round(float(scoped_non_mounted[name]) * 1000, 3)
            if name in scoped_non_adjacent:
                per_part_clearance[name]["non_adjacent_mm"] = round(float(scoped_non_adjacent[name]) * 1000, 3)
    non_mounted_values = [
        value["non_mounted_mm"] for value in per_part_clearance.values() if value["non_mounted_mm"] is not None
    ]
    non_adjacent_values = [
        value["non_adjacent_mm"] for value in per_part_clearance.values() if value["non_adjacent_mm"] is not None
    ]
    face_visual_finish = params.get("materials", {}).get("face_shell", {}).get("visual_finish", {})
    parametric_face = face.source_kind == "parametric_donor_face_grid"
    report = {
        "verdict": (
            "pass"
            if comparisons and all(row["within_tolerance"] for row in comparisons.values())
            else "needs-work"
        ),
        "reference_source": targets.get(
            "source", "eliza_front_reference.png visible-face proportions, excluding hair and glasses"
        ),
        "face_shell_source": face.source_asset,
        "face_shell_bounds_mm": np.round(bounds * 1000, 3).tolist(),
        "face_shell_extents_mm": np.round(extents * 1000, 3).tolist(),
        "aesthetic_depth_verdict": "pass" if face_depth_check["within_tolerance"] else "needs-work",
        "face_shell_depth_check": face_depth_check,
        "insert_centers_mm": {
            "left_eye_insert": np.round(left_eye_center * 1000, 3).tolist(),
            "right_eye_insert": np.round(right_eye_center * 1000, 3).tolist(),
            "lip_insert": np.round(lip_center * 1000, 3).tolist(),
        },
        "metrics": {key: round(float(value), 4) for key, value in metrics.items()},
        "targets": {key: targets.get(key) for key in metrics if key in targets},
        "tolerance": tolerance,
        "comparisons": comparisons,
        "scoped_clearance_mm": per_part_clearance,
        "minimum_neck_head_face_non_mounted_clearance_mm": (
            round(float(min(non_mounted_values)), 3) if non_mounted_values else None
        ),
        "minimum_neck_head_face_non_adjacent_clearance_mm": (
            round(float(min(non_adjacent_values)), 3) if non_adjacent_values else None
        ),
        "operating_sweep": scoped_sweep,
        "face_production_surfacing": {
            "verdict": "parametric-step-pass" if parametric_face else ("visual-only-pass" if face_visual_finish else "needs-work"),
            "preserves_fit_geometry": not parametric_face,
            "source_kind": face.source_kind,
            "face_depth_mm": face_depth_check["actual_mm"],
            "surface_method": (
                "fixed-yz-grid donor mesh sampling with closed x/y section lofts"
                if parametric_face
                else "render-only finish metadata on imported donor mesh"
            ),
            "visual_finish": face_visual_finish,
            "collision_mesh_changed": parametric_face,
        },
        "note": (
            "Face alignment uses the donor-derived parametric face shell plus separate eye/lip inserts. "
            "Hair and glasses in the concept references are reference-only and are not generated."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "face-alignment-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def write_mechanical_stress_blocker_report(params: dict[str, Any], fit: dict[str, Any]) -> dict[str, Any]:
    target_mm = float(params["fit"]["dynamic_joint_clearance_mm"])
    sweep = fit.get("mechanical_dynamic_joint_sweep", {})
    pose_results = sweep.get("pose_results", [])
    blockers: list[dict[str, Any]] = []
    grouped: dict[str, dict[str, Any]] = {}
    for row in pose_results:
        clearance = row.get("minimum_non_adjacent_clearance_mm")
        worst = row.get("worst_non_adjacent_clearance") or {}
        part = worst.get("part")
        if clearance is None or part is None or float(clearance) >= target_mm:
            continue
        region = _part_region(str(part))
        item = {
            "pose": row.get("pose"),
            "clearance_mm": round(float(clearance), 3),
            "target_mm": target_mm,
            "shortfall_mm": round(target_mm - float(clearance), 3),
            "part": part,
            "region": region,
            "part_body": worst.get("part_body"),
            "base_body": worst.get("base_body"),
            "base_geom": worst.get("base_geom"),
            "base_geom_type": worst.get("base_geom_type"),
            "body_tree_distance": worst.get("body_tree_distance"),
            "part_sample_point_m": worst.get("part_sample_point_m"),
            "base_sample_point_m": worst.get("base_sample_point_m"),
            "part_to_base_vector_m": worst.get("part_to_base_vector_m"),
            "part_to_base_vector_mm": worst.get("part_to_base_vector_mm"),
        }
        blockers.append(item)
        group = grouped.setdefault(
            region,
            {
                "blocker_count": 0,
                "minimum_clearance_mm": None,
                "parts": {},
            },
        )
        group["blocker_count"] += 1
        if group["minimum_clearance_mm"] is None or item["clearance_mm"] < group["minimum_clearance_mm"]:
            group["minimum_clearance_mm"] = item["clearance_mm"]
        part_group = group["parts"].setdefault(
            str(part),
            {
                "blocker_count": 0,
                "minimum_clearance_mm": None,
                "poses": [],
            },
        )
        part_group["blocker_count"] += 1
        part_group["poses"].append(item["pose"])
        if (
            part_group["minimum_clearance_mm"] is None
            or item["clearance_mm"] < part_group["minimum_clearance_mm"]
        ):
            part_group["minimum_clearance_mm"] = item["clearance_mm"]

    blockers.sort(key=lambda row: row["clearance_mm"])
    head_keepout_candidates = [
        row
        for row in blockers
        if row["part"] == "face_shell" and str(row.get("base_body", "")).endswith("wrist_roll_link")
    ]
    head_keepout_policy = {
        "verdict": "needs-implementation" if head_keepout_candidates else "pass",
        "candidate_count": len(head_keepout_candidates),
        "target_mm": target_mm,
        "minimum_candidate_clearance_mm": (
            min(row["clearance_mm"] for row in head_keepout_candidates) if head_keepout_candidates else None
        ),
        "candidate_poses": [row["pose"] for row in head_keepout_candidates],
        "candidate_rows": head_keepout_candidates,
        "controlled_part": "face_shell",
        "controlled_base_body_suffix": "wrist_roll_link",
        "enforcement": {
            "policy_verdict": "needs-controller-enforcement" if head_keepout_candidates else "pass",
            "clearance_gate_mm": target_mm,
            "blocked_or_replanned_poses": [row["pose"] for row in head_keepout_candidates],
            "controlled_part": "face_shell",
            "controlled_base_body_suffix": "wrist_roll_link",
            "rationale": (
                "The candidate rows are extreme wrist poses entering the protected face volume. "
                "A geometry-only fix large enough to clear them would degrade the donor-derived face."
            ),
        },
        "required_action": (
            "Implement controller joint-limit or keepout-volume enforcement for candidate poses, or replace "
            "the physical wrist/forearm geometry, before claiming extreme-pose mechanical release."
        ),
        "design_guardrail": (
            "Do not satisfy these rows by further flattening the donor-derived face unless the replacement "
            "face still passes concept-alignment review and visual inspection."
        ),
    }
    report = {
        "verdict": "pass" if not blockers else "needs-work",
        "target_mm": target_mm,
        "mechanical_sweep_fraction": sweep.get("sweep_fraction"),
        "minimum_non_adjacent_clearance_mm": sweep.get("minimum_non_adjacent_clearance_mm"),
        "worst_pose": sweep.get("worst_non_adjacent_pose"),
        "blocker_count": len(blockers),
        "top_blockers": blockers[:30],
        "regions": grouped,
        "head_keepout_policy": {
            "verdict": head_keepout_policy["verdict"],
            "candidate_count": head_keepout_policy["candidate_count"],
            "minimum_candidate_clearance_mm": head_keepout_policy["minimum_candidate_clearance_mm"],
            "candidate_poses": head_keepout_policy["candidate_poses"],
            "enforcement": head_keepout_policy["enforcement"],
            "recommendation": (
                "Treat face_shell versus wrist_roll_link mechanical-sweep rows as head-protection "
                "keepout candidates before further flattening or shrinking the donor-derived face. "
                "The rows remain blockers until a joint-limit policy, physical wrist geometry change, "
                "or wider face-safe clearance is implemented and verified."
            ),
        },
        "note": (
            "Mechanical stress blockers are derived from the wider stress sweep only. "
            "They do not override the operating production-fit verdict, but they must be "
            "closed before claiming hard tooling or extreme-pose mechanical release."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "mechanical-stress-blockers.json").write_text(json.dumps(report, indent=2) + "\n")
    (REVIEW_ROOT / "head-keepout-policy.json").write_text(json.dumps(head_keepout_policy, indent=2) + "\n")
    return report


def export_assembled_bodykit(mjcf_path: Path, parts: list[Part]) -> dict[str, str]:
    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    _set_home_pose(model, data, {})
    assembled = []
    for part in parts:
        world = _body_world_mesh(model, data, part.body, part.mesh)
        world.metadata["name"] = part.name
        assembled.append(world)
    mesh = trimesh.util.concatenate(assembled)
    mesh.merge_vertices()
    obj_path = OUT_ROOT / "unitree-r1-bodykit-assembled-home.obj"
    glb_path = OUT_ROOT / "unitree-r1-bodykit-assembled-home.glb"
    mesh.export(obj_path)
    mesh.export(glb_path)
    return {"obj": str(obj_path), "glb": str(glb_path)}


def validate_panel_gaps(params: dict[str, Any], mjcf_path: Path, parts: list[Part]) -> dict[str, Any]:
    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    _set_home_pose(model, data, params)

    world_meshes = {part.name: _body_world_mesh(model, data, part.body, part.mesh) for part in parts}
    rows: list[dict[str, Any]] = []
    seated_detail_rows: list[dict[str, Any]] = []
    min_gap = float("inf")
    max_gap = 0.0
    checked_pairs = 0
    near_gap_pairs = 0
    pairs_below_nominal_gap = 0
    target_mm = float(params["fit"]["nominal_panel_gap_mm"])
    articulation_gap_mm = 1.0
    seated_detail_gap_mm = float(params["fit"].get("seated_detail_gap_mm", 0.1))
    max_review_mm = 45.0

    def pair_gap_gate(a: Part, b: Part) -> tuple[float, str]:
        if a.body != b.body:
            return articulation_gap_mm, "articulated"
        roles = {a.role, b.role}
        if roles == {"face", "face_detail"}:
            return seated_detail_gap_mm, "seated_detail"
        return target_mm, "rigid_panel"

    def deterministic_points(mesh: trimesh.Trimesh, limit: int = 480) -> np.ndarray:
        points = np.asarray(mesh.vertices, dtype=float)
        if len(points) > limit:
            points = points[np.linspace(0, len(points) - 1, limit, dtype=int)]
        return points

    for index, a in enumerate(parts):
        a_mesh = world_meshes[a.name]
        if len(a_mesh.vertices) == 0:
            continue
        a_samples = deterministic_points(a_mesh)
        for b in parts[index + 1 :]:
            b_mesh = world_meshes[b.name]
            if len(b_mesh.vertices) == 0:
                continue
            b_samples = deterministic_points(b_mesh)
            a_to_b = cKDTree(b_samples).query(a_samples, k=1)[0]
            b_to_a = cKDTree(a_samples).query(b_samples, k=1)[0]
            pair_min_mm = float(min(np.min(a_to_b), np.min(b_to_a)) * 1000)
            if pair_min_mm > max_review_mm:
                continue
            checked_pairs += 1
            min_gap = min(min_gap, pair_min_mm)
            max_gap = max(max_gap, pair_min_mm)
            articulated = a.body != b.body
            gap_gate_mm, interface_type = pair_gap_gate(a, b)
            if pair_min_mm < target_mm:
                pairs_below_nominal_gap += 1
            if pair_min_mm < gap_gate_mm:
                near_gap_pairs += 1
            row = {
                "part_a": a.name,
                "body_a": a.body,
                "role_a": a.role,
                "part_b": b.name,
                "body_b": b.body,
                "role_b": b.role,
                "minimum_sampled_gap_mm": round(pair_min_mm, 3),
                "articulated_interface": articulated,
                "interface_type": interface_type,
                "gap_gate_mm": gap_gate_mm,
                "below_nominal_gap": pair_min_mm < target_mm,
                "below_gap_gate": pair_min_mm < gap_gate_mm,
            }
            rows.append(row)
            if interface_type == "seated_detail":
                seated_detail_rows.append(row)

    rows.sort(key=lambda row: row["minimum_sampled_gap_mm"])
    report = {
        "verdict": "pass" if near_gap_pairs == 0 else "needs-work",
        "nominal_panel_gap_mm": target_mm,
        "minimum_articulation_gap_mm": articulation_gap_mm,
        "seated_detail_gap_mm": seated_detail_gap_mm,
        "max_review_gap_mm": max_review_mm,
        "pairs_checked": checked_pairs,
        "pairs_below_nominal_gap": pairs_below_nominal_gap,
        "pairs_below_gap_gate": near_gap_pairs,
        "minimum_sampled_panel_gap_mm": None if min_gap == float("inf") else round(min_gap, 3),
        "maximum_nearby_sampled_panel_gap_mm": round(max_gap, 3),
        "worst_pairs": rows[:30],
        "seated_detail_pairs": sorted(seated_detail_rows, key=lambda row: row["minimum_sampled_gap_mm"]),
        "note": (
            "This is sampled mesh-to-mesh evidence for nearby bodykit parts in the home pose. "
            "Face inserts use a seated-detail gate instead of the normal rigid panel seam gate, "
            "but they remain included in the mechanical stress clearance sweep. "
            "Production release still needs exact CAD gap checks after split lines, mounts, "
            "and inner shell offsets are surfaced."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "panel-gap-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def render_review(mjcf_path: Path) -> list[Path]:
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    params = _load_params()
    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    data.qpos[:] = 0
    data.qpos[2] = 0.74
    data.qpos[3] = 1.0
    mujoco.mj_forward(model, data)

    out: list[Path] = []
    operating_fraction = float(params["fit"].get("operating_sweep_fraction", 0.25))
    mechanical_fraction = float(params["fit"].get("mechanical_sweep_fraction", 0.65))
    neutral_pose: list[tuple[str, str, float]] = []
    operating_blocker_pose = [
        ("left_shoulder_pitch_joint", "high", operating_fraction),
        ("left_elbow_joint", "high", operating_fraction),
    ]
    mechanical_blocker_pose = [
        ("right_shoulder_pitch_joint", "low", mechanical_fraction),
    ]
    camera_specs = {
        "bodykit_front": {
            "pose": neutral_pose,
            "lookat": [0.03, 0.0, 0.80],
            "distance": 1.9,
            "azimuth": 180,
            "elevation": -8,
        },
        "bodykit_rear": {
            "pose": neutral_pose,
            "lookat": [0.03, 0.0, 0.80],
            "distance": 1.9,
            "azimuth": 0,
            "elevation": -8,
        },
        "bodykit_left": {
            "pose": neutral_pose,
            "lookat": [0.03, 0.0, 0.80],
            "distance": 1.9,
            "azimuth": 90,
            "elevation": -8,
        },
        "bodykit_right": {
            "pose": neutral_pose,
            "lookat": [0.03, 0.0, 0.80],
            "distance": 1.9,
            "azimuth": -90,
            "elevation": -8,
        },
        "bodykit_head": {
            "pose": neutral_pose,
            "lookat": [0.07, 0.0, 1.30],
            "distance": 0.55,
            "azimuth": 180,
            "elevation": -5,
        },
        "bodykit_head_three_quarter": {
            "pose": neutral_pose,
            "lookat": [0.07, 0.0, 1.29],
            "distance": 0.62,
            "azimuth": 145,
            "elevation": -8,
        },
        "bodykit_upper_three_quarter": {
            "pose": neutral_pose,
            "lookat": [0.05, 0.0, 1.05],
            "distance": 1.15,
            "azimuth": 145,
            "elevation": -10,
        },
        "bodykit_operating_blocker_front": {
            "pose": operating_blocker_pose,
            "lookat": [0.03, 0.0, 0.84],
            "distance": 1.9,
            "azimuth": 180,
            "elevation": -8,
        },
        "bodykit_operating_blocker_left": {
            "pose": operating_blocker_pose,
            "lookat": [0.03, 0.0, 0.84],
            "distance": 1.9,
            "azimuth": 90,
            "elevation": -8,
        },
        "bodykit_mechanical_blocker_head": {
            "pose": mechanical_blocker_pose,
            "lookat": [0.08, -0.02, 1.25],
            "distance": 0.72,
            "azimuth": -135,
            "elevation": -6,
        },
        "bodykit_mechanical_blocker_right": {
            "pose": mechanical_blocker_pose,
            "lookat": [0.04, 0.0, 1.03],
            "distance": 1.55,
            "azimuth": -90,
            "elevation": -8,
        },
    }
    try:
        renderer = mujoco.Renderer(model, height=480, width=640)
        for name, spec in camera_specs.items():
            if spec["pose"]:
                _set_named_joint_pose(model, data, spec["pose"])
            else:
                _set_home_pose(model, data, params)
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = spec["lookat"]
            cam.distance = spec["distance"]
            cam.azimuth = spec["azimuth"]
            cam.elevation = spec["elevation"]
            renderer.update_scene(data, camera=cam)
            rgb = renderer.render()
            path = REVIEW_ROOT / f"{name}.png"
            Image.fromarray(rgb).save(path)
            out.append(path)
        renderer.close()
    except Exception as exc:
        # Headless systems without a working GL backend still get an audit
        # artifact instead of silently succeeding.
        path = REVIEW_ROOT / "render-blocked.txt"
        path.write_text(f"MuJoCo offscreen render failed: {type(exc).__name__}: {exc}\n")
        out.append(path)
        return out

    sheet = REVIEW_ROOT / "bodykit-contact-sheet.png"
    thumbs = [Image.open(p).resize((320, 240)) for p in out]
    cols = 3
    rows = math.ceil(len(thumbs) / cols)
    canvas = Image.new("RGB", (320 * cols, 240 * rows), (20, 20, 22))
    draw = ImageDraw.Draw(canvas)
    for idx, (name, img) in enumerate(zip(camera_specs, thumbs, strict=True)):
        x = (idx % 3) * 320
        y = (idx // 3) * 240
        canvas.paste(img, (x, y))
        draw.text((x + 10, y + 10), name, fill=(255, 255, 255))
    canvas.save(sheet)
    out.append(sheet)
    out.extend(write_concept_overlays(params, out))
    return out


def write_concept_overlays(params: dict[str, Any], render_paths: list[Path]) -> list[Path]:
    concept_path = _concept_reference_path(params)
    if concept_path is None:
        return []
    concept = Image.open(concept_path).convert("RGB")
    review_concept = REVIEW_ROOT / "visual-concept-orange-android.png"
    concept.save(review_concept)
    overlay_targets = [
        "bodykit_front",
        "bodykit_left",
        "bodykit_right",
        "bodykit_rear",
        "bodykit_operating_blocker_front",
        "bodykit_operating_blocker_left",
        "bodykit_mechanical_blocker_right",
    ]
    render_by_stem = {path.stem: path for path in render_paths if path.suffix.lower() == ".png"}
    outputs = [review_concept]
    for stem in overlay_targets:
        render_path = render_by_stem.get(stem)
        if render_path is None or not render_path.is_file():
            continue
        render = Image.open(render_path).convert("RGB")
        background = _fit_image_cover(concept, render.size).filter(ImageFilter.GaussianBlur(radius=1.2))
        background = Image.blend(Image.new("RGB", render.size, (28, 28, 30)), background, 0.38)
        corner_samples = [
            render.getpixel((0, 0)),
            render.getpixel((render.width - 1, 0)),
            render.getpixel((0, render.height - 1)),
            render.getpixel((render.width - 1, render.height - 1)),
        ]
        bg = np.asarray(corner_samples, dtype=float).mean(axis=0)
        arr = np.asarray(render, dtype=np.int16)
        diff = np.linalg.norm(arr - bg[None, None, :], axis=2)
        alpha = np.clip((diff - 9.0) / 38.0, 0.0, 1.0)
        alpha = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=0.8))
        composite = Image.composite(render, background, alpha)
        draw = ImageDraw.Draw(composite)
        draw.text((12, 12), f"{stem} over concept", fill=(255, 255, 255))
        out = REVIEW_ROOT / f"{stem}_concept_overlay.png"
        composite.save(out)
        outputs.append(out)
    reference_report_path = REVIEW_ROOT / "reference-validation.json"
    reference = json.loads(reference_report_path.read_text()) if reference_report_path.is_file() else {}
    mesh = reference.get("mesh") or {}
    scale_text = (
        f"reference GLB height {mesh.get('height_m', 'unknown')}m; "
        f"scale to R1 {mesh.get('scale_to_r1_height', 'unknown')}"
    )
    for stem in ["bodykit_front", "bodykit_left", "bodykit_right"]:
        overlay = REVIEW_ROOT / f"{stem}_concept_overlay.png"
        if not overlay.is_file():
            continue
        image = Image.open(overlay).convert("RGB")
        draw = ImageDraw.Draw(image)
        cx = image.width // 2
        draw.line((cx, 0, cx, image.height), fill=(255, 255, 255), width=1)
        draw.line((0, image.height // 2, image.width, image.height // 2), fill=(255, 255, 255), width=1)
        margin_x = int(image.width * 0.28)
        margin_y = int(image.height * 0.06)
        draw.rectangle(
            (margin_x, margin_y, image.width - margin_x, image.height - margin_y),
            outline=(255, 128, 0),
            width=2,
        )
        draw.text((12, image.height - 34), scale_text, fill=(255, 255, 255))
        out = REVIEW_ROOT / f"{stem}_reference_scale_overlay.png"
        image.save(out)
        outputs.append(out)
    return outputs


def write_render_validation(renders: list[Path], video: Path | None) -> dict[str, Any]:
    required_images = [
        "bodykit_front.png",
        "bodykit_rear.png",
        "bodykit_left.png",
        "bodykit_right.png",
        "bodykit_head.png",
        "bodykit_head_three_quarter.png",
        "bodykit_upper_three_quarter.png",
        "bodykit_operating_blocker_front.png",
        "bodykit_operating_blocker_left.png",
        "bodykit_mechanical_blocker_head.png",
        "bodykit_mechanical_blocker_right.png",
        "bodykit-contact-sheet.png",
        "visual-concept-orange-android.png",
        "bodykit_front_concept_overlay.png",
        "bodykit_left_concept_overlay.png",
        "bodykit_right_concept_overlay.png",
        "bodykit_rear_concept_overlay.png",
        "bodykit_operating_blocker_front_concept_overlay.png",
        "bodykit_operating_blocker_left_concept_overlay.png",
        "bodykit_mechanical_blocker_right_concept_overlay.png",
        "bodykit_front_reference_scale_overlay.png",
        "bodykit_left_reference_scale_overlay.png",
        "bodykit_right_reference_scale_overlay.png",
    ]
    image_reports = []
    missing = []
    blank = []
    for name in required_images:
        path = REVIEW_ROOT / name
        if not path.is_file():
            missing.append(name)
            image_reports.append({"name": name, "exists": False})
            continue
        image = Image.open(path).convert("RGB")
        stat = ImageStat.Stat(image)
        stddev = [round(float(x), 3) for x in stat.stddev]
        is_blank = max(stddev) < 1.0
        if is_blank:
            blank.append(name)
        image_reports.append(
            {
                "name": name,
                "exists": True,
                "path": str(path),
                "width": image.width,
                "height": image.height,
                "bytes": path.stat().st_size,
                "stddev_rgb": stddev,
                "nonblank": not is_blank,
            }
        )
    video_report = None
    if video is not None:
        video_report = {
            "path": str(video),
            "exists": video.is_file(),
            "bytes": video.stat().st_size if video.is_file() else 0,
            "nonzero": video.is_file() and video.stat().st_size > 0,
        }
    report = {
        "verdict": "pass" if not missing and not blank else "needs-work",
        "required_images": required_images,
        "images": image_reports,
        "missing_images": missing,
        "blank_images": blank,
        "video": video_report,
        "rendered_paths": [str(path) for path in renders],
    }
    (REVIEW_ROOT / "render-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def render_orbit_video(mjcf_path: Path) -> Path:
    video_dir = REVIEW_ROOT / "video_frames"
    if video_dir.exists():
        shutil.rmtree(video_dir)
    video_dir.mkdir(parents=True, exist_ok=True)
    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    data.qpos[:] = 0
    data.qpos[2] = 0.74
    data.qpos[3] = 1.0
    mujoco.mj_forward(model, data)
    renderer = mujoco.Renderer(model, height=480, width=640)
    try:
        for frame in range(96):
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = [0.03, 0.0, 0.82]
            cam.distance = 1.75
            cam.azimuth = (180 + frame * 360 / 96) % 360
            cam.elevation = -7
            renderer.update_scene(data, camera=cam)
            Image.fromarray(renderer.render()).save(video_dir / f"frame_{frame:04d}.png")
    finally:
        renderer.close()
    out = REVIEW_ROOT / "unitree-r1-bodykit-orbit.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            "24",
            "-i",
            str(video_dir / "frame_%04d.png"),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(out),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    shutil.rmtree(video_dir)
    return out


def write_design_source_audit(params: dict[str, Any], parts: list[Part]) -> dict[str, Any]:
    shell_roles = {"armor", "underbody", "face"}
    rows = []
    missing = []
    for part in parts:
        shell_part = part.role in shell_roles
        row = {
            "part": part.name,
            "role": part.role,
            "body": part.body,
            "source_kind": part.source_kind,
            "source_asset": part.source_asset,
            "oem_baseline_meshes": list(part.oem_baseline_meshes),
            "requires_oem_baseline": shell_part,
            "has_oem_baseline": bool(part.oem_baseline_meshes),
            "current_geometry_status": (
                "parametric donor grid loft"
                if part.source_kind == "parametric_donor_face_grid"
                else ("imported donor surface" if part.source_kind == "human_donor" else "parametric EVT envelope")
            ),
        }
        if shell_part and not part.oem_baseline_meshes:
            missing.append(part.name)
        rows.append(row)
    report = {
        "verdict": "pass" if not missing else "needs-work",
        "shell_parts_checked": sum(1 for p in parts if p.role in shell_roles),
        "missing_oem_baseline_parts": missing,
        "parts": rows,
        "note": (
            "This audit verifies source provenance only. It does not prove that primitive EVT "
            "geometry has already been rebuilt from OEM offset envelopes."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "design-source-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def write_parametric_reconstruction_audit(
    params: dict[str, Any],
    parts: list[Part],
    step_report: dict[str, Any],
    base_reconstruction: dict[str, Any],
) -> dict[str, Any]:
    spec_by_name = {str(spec["name"]): spec for spec in params["parts"]}
    shell_roles = {"armor", "underbody", "face"}
    source_counts: dict[str, int] = {}
    shape_counts: dict[str, int] = {}
    primitive_shell_parts = []
    morph_ready_parts = []
    rows = []
    for part in parts:
        spec = spec_by_name[part.name]
        shape = str(spec["shape"])
        source_kind = part.source_kind
        source_counts[source_kind] = source_counts.get(source_kind, 0) + 1
        shape_counts[shape] = shape_counts.get(shape, 0) + 1
        shell_part = part.role in shell_roles
        step_path = STEP_ROOT / f"{part.name}.step"
        has_section_params = shape in {"section_loft", "donor_face_grid_loft"}
        has_simple_parameters = shape in {
            "ellipsoid",
            "capsule_z",
            "capsule_x",
            "capsule_y",
            "box",
            "tapered_box",
            "cylinder_x",
            "cylinder_y",
            "cylinder_z",
            "torus_x",
            "torus_y",
            "torus_z",
        }
        reconstruction_status = (
            "morph-ready-section-loft"
            if has_section_params
            else ("simple-parametric-solid-needs-loft-reconstruction" if has_simple_parameters else "mesh-derived-needs-rebuild")
        )
        row = {
            "part": part.name,
            "region": _part_region(part.name),
            "role": part.role,
            "body": part.body,
            "shape": shape,
            "source_kind": source_kind,
            "oem_baseline_meshes": list(part.oem_baseline_meshes),
            "step_solid_exported": step_path.is_file(),
            "reconstruction_status": reconstruction_status,
            "has_morph_history": bool(spec.get("morph_history")),
            "has_section_parameters": has_section_params,
            "uses_simple_primitive_parameters": has_simple_parameters and not has_section_params,
            "next_reconstruction_step": (
                "sample OEM/reference mesh on fixed grid and replace primitive with section_loft or specialized face/body loft"
                if shell_part and reconstruction_status == "simple-parametric-solid-needs-loft-reconstruction"
                else "carry forward into morph/control optimization"
            ),
        }
        if shell_part and reconstruction_status == "simple-parametric-solid-needs-loft-reconstruction":
            primitive_shell_parts.append(part.name)
        if has_section_params or bool(spec.get("morph_history")):
            morph_ready_parts.append(part.name)
        rows.append(row)
    report = {
        "verdict": "needs-work" if primitive_shell_parts else "pass",
        "bodykit_parts": len(parts),
        "step_export_status": step_report["status"],
        "step_exported_count": step_report["exported_count"],
        "base_reconstruction_verdict": base_reconstruction["verdict"],
        "base_reconstructed_assets": base_reconstruction.get("reconstructed_count", 0),
        "official_base_step_source_available": base_reconstruction.get("official_step_source_available", False),
        "source_kind_counts": dict(sorted(source_counts.items())),
        "shape_counts": dict(sorted(shape_counts.items())),
        "morph_ready_count": len(set(morph_ready_parts)),
        "primitive_shell_count": len(primitive_shell_parts),
        "primitive_shell_parts": primitive_shell_parts,
        "morph_ready_parts": sorted(set(morph_ready_parts)),
        "completion_gate": (
            "blocked-until-simple shell primitives are rebuilt as fixed-grid loft/surface CAD with connector parameters"
        ),
        "parts": rows,
    }
    (REVIEW_ROOT / "parametric-reconstruction-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def _part_region(name: str) -> str:
    if any(token in name for token in ["foot", "ankle"]):
        return "feet_ankles"
    if any(token in name for token in ["thigh", "shin", "knee"]):
        return "legs"
    if any(token in name for token in ["shoulder", "upper_arm", "forearm", "wrist"]):
        return "arms"
    if any(token in name for token in ["pelvis", "hip", "abdomen", "chest", "torso", "back", "rear"]):
        return "hips_torso_chest_back"
    if any(token in name for token in ["head", "face", "eye", "lip", "neck"]):
        return "neck_head_face"
    return "unclassified"


def write_part_review_report(
    parts: list[Part], fit: dict[str, Any], panel_gap: dict[str, Any], face_alignment: dict[str, Any]
) -> dict[str, Any]:
    regions = {
        "feet_ankles": {
            "visual_focus": "low armored shoe shells, black sole bands, ankle joint clearance",
            "review_images": [
                "bodykit_front.png",
                "bodykit_left.png",
                "bodykit_right.png",
                "bodykit_front_concept_overlay.png",
                "bodykit_left_concept_overlay.png",
                "bodykit_right_concept_overlay.png",
            ],
        },
        "legs": {
            "visual_focus": "slim thigh/shin armor, knee articulation reveals, calf taper",
            "review_images": [
                "bodykit_front.png",
                "bodykit_left.png",
                "bodykit_right.png",
                "bodykit_front_concept_overlay.png",
                "bodykit_left_concept_overlay.png",
                "bodykit_right_concept_overlay.png",
            ],
        },
        "hips_torso_chest_back": {
            "visual_focus": "tapered waist, armored chest contour, rear spine/hip fairings",
            "review_images": [
                "bodykit_front.png",
                "bodykit_rear.png",
                "bodykit_upper_three_quarter.png",
                "bodykit_front_concept_overlay.png",
                "bodykit_rear_concept_overlay.png",
            ],
        },
        "arms": {
            "visual_focus": "slim shoulder/upper-arm/forearm shells and elbow articulation gaps",
            "review_images": [
                "bodykit_front.png",
                "bodykit_left.png",
                "bodykit_right.png",
                "bodykit_front_concept_overlay.png",
                "bodykit_left_concept_overlay.png",
                "bodykit_right_concept_overlay.png",
                "bodykit_operating_blocker_front_concept_overlay.png",
                "bodykit_mechanical_blocker_right_concept_overlay.png",
            ],
        },
        "neck_head_face": {
            "visual_focus": "donor face alignment, hard-plastic head boundary, neck carrier fit",
            "review_images": [
                "bodykit_head.png",
                "bodykit_head_three_quarter.png",
                "bodykit_front_concept_overlay.png",
                "bodykit_mechanical_blocker_right_concept_overlay.png",
                "eliza-face-donor.png",
            ],
        },
    }
    grouped: dict[str, list[Part]] = {name: [] for name in regions}
    grouped["unclassified"] = []
    for part in parts:
        grouped.setdefault(_part_region(part.name), []).append(part)

    per_part_clearance = fit.get("per_part_non_mounted_clearance_mm", {})
    panel_rows = panel_gap.get("worst_pairs", [])
    report_regions = {}
    for region, spec in regions.items():
        region_parts = grouped.get(region, [])
        names = [p.name for p in region_parts]
        region_clearances = [
            float(per_part_clearance[name]) for name in names if name in per_part_clearance
        ]
        region_panel_rows = [
            row
            for row in panel_rows
            if row.get("part_a") in names or row.get("part_b") in names
        ]
        report_regions[region] = {
            "part_count": len(region_parts),
            "parts": names,
            "visual_focus": spec["visual_focus"],
            "review_images": spec["review_images"],
            "visual_inspection_status": "needs-work",
            "programmatic_checks": {
                "minimum_non_mounted_clearance_mm": (
                    round(min(region_clearances), 3) if region_clearances else None
                ),
                "panel_gap_verdict": panel_gap["verdict"],
                "worst_panel_pairs": region_panel_rows[:5],
            },
            "manufacturing_status": "evt-prototype-source-needs-production-surfacing",
        }
        if region == "neck_head_face":
            report_regions[region]["programmatic_checks"]["face_alignment_verdict"] = face_alignment["verdict"]
            report_regions[region]["programmatic_checks"]["face_alignment_metrics"] = face_alignment["metrics"]
            report_regions[region]["programmatic_checks"][
                "minimum_non_adjacent_clearance_mm"
            ] = face_alignment["minimum_neck_head_face_non_adjacent_clearance_mm"]
    report = {
        "verdict": "needs-work",
        "bodykit_parts": len(parts),
        "regions": report_regions,
        "unclassified_parts": [p.name for p in grouped.get("unclassified", [])],
        "review_contract": (
            "Every generated bodykit part is assigned to a region for visual review, "
            "clearance review, panel-gap review, and manufacturing follow-up. "
            "The report is not a final aesthetic approval."
        ),
    }
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    (REVIEW_ROOT / "part-review-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def write_manufacturing_outputs(
    params: dict[str, Any],
    parts: list[Part],
    fit: dict[str, Any],
    panel_gap: dict[str, Any],
    step_report: dict[str, Any],
    source_audit: dict[str, Any],
    reconstruction_audit: dict[str, Any],
    part_review: dict[str, Any],
    face_alignment: dict[str, Any],
) -> None:
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    layout_rows = []
    dfm_rules = []
    max_shapeways_standard_mm = np.asarray([650.0, 350.0, 550.0])
    max_shapeways_smooth_color_mm = np.asarray([180.0, 230.0, 320.0])
    for p in parts:
        extents_mm = np.asarray(p.mesh.extents) * 1000
        longest_axis = int(np.argmax(extents_mm))
        orientation = ["x", "y", "z"][longest_axis]
        shapeways_standard_ok = bool(np.all(np.sort(extents_mm) <= np.sort(max_shapeways_standard_mm)))
        shapeways_smooth_color_ok = bool(
            np.all(np.sort(extents_mm) <= np.sort(max_shapeways_smooth_color_mm))
        )
        volume_cm3 = float(abs(p.mesh.volume) * 1_000_000)
        layout_rows.append(
            {
                "name": p.name,
                "material": p.material,
                "role": p.role,
                "bbox_x_mm": round(float(extents_mm[0]), 2),
                "bbox_y_mm": round(float(extents_mm[1]), 2),
                "bbox_z_mm": round(float(extents_mm[2]), 2),
                "approx_solid_volume_cm3": round(volume_cm3, 2),
                "recommended_print_axis_up": orientation,
                "shapeways_pa12_standard_bbox_ok": shapeways_standard_ok,
                "shapeways_pa12_smooth_color_bbox_ok": shapeways_smooth_color_ok,
                "stl": str(p.stl_path),
                "step": str(STEP_ROOT / f"{p.name}.step"),
                "source_kind": p.source_kind,
                "source_asset": p.source_asset,
                "oem_baseline_meshes": ";".join(p.oem_baseline_meshes),
            }
        )
        step_exported = (STEP_ROOT / f"{p.name}.step").is_file()
        dfm_rules.append(
            {
                "part": p.name,
                "bbox_mm": [round(float(x), 2) for x in extents_mm],
                "service_print_bbox_ok": shapeways_standard_ok,
                "mold_candidate": True,
                "requires_parting_line_review": True,
                "requires_boss_rib_insert_detail": p.role in {"armor", "underbody", "face"},
                "step_solid_exported": step_exported,
                "source_kind": p.source_kind,
                "source_asset": p.source_asset,
                "oem_baseline_meshes": list(p.oem_baseline_meshes),
                "requires_production_surface_rebuild_before_tooling": True,
            }
        )
    manifest = {
        "project": params["project"],
        "fit": params["fit"],
        "fit_validation": fit,
        "panel_gap_validation": panel_gap,
        "part_review": part_review,
        "face_alignment_validation": face_alignment,
        "step_export": step_report,
        "design_source_audit": source_audit,
        "parametric_reconstruction_audit": reconstruction_audit,
        "print_layout": layout_rows,
        "dfm_rules": dfm_rules,
        "parts": [
            {
                "name": p.name,
                "body": p.body,
                "role": p.role,
                "material": p.material,
                "stl": str(p.stl_path),
                "obj": str(p.obj_path),
                "step": str(STEP_ROOT / f"{p.name}.step"),
                "source_kind": p.source_kind,
                "source_asset": p.source_asset,
                "oem_baseline_meshes": list(p.oem_baseline_meshes),
                "prototype_process": params["materials"][p.material]["prototype"],
                "production_process": params["materials"][p.material]["production"],
                "print_layout": {
                    "service": "Shapeways or equivalent bureau",
                    "orientation": "cosmetic face upward; split larger shells before order if bounding box exceeds service limit",
                    "minimum_wall_mm": params["fit"]["min_print_wall_mm"],
                },
                "injection_molding": {
                    "draft_deg": params["fit"]["draft_deg"],
                    "minimum_wall_mm": params["fit"]["min_mold_wall_mm"],
                    "shrink_allowance_percent": params["fit"]["shrink_allowance_percent"],
                    "step_solid_exported": (STEP_ROOT / f"{p.name}.step").is_file(),
                    "requires_production_surface_rebuild": True,
                },
            }
            for p in parts
        ],
    }
    (REVIEW_ROOT / "manufacturing-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with (REVIEW_ROOT / "shapeways-print-layout.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(layout_rows[0].keys()))
        writer.writeheader()
        writer.writerows(layout_rows)
    print_quote_ready = all(row["shapeways_pa12_standard_bbox_ok"] for row in layout_rows)
    prototype_fit_ready = fit.get("simulator_verdict") == "pass"
    tooling_ready = (
        fit.get("production_fit_verdict") == "pass"
        and panel_gap["verdict"] == "pass"
        and step_report["status"] == "exported"
        and source_audit["verdict"] == "pass"
        and all(rule["step_solid_exported"] for rule in dfm_rules)
        and not any(rule["requires_production_surface_rebuild_before_tooling"] for rule in dfm_rules)
    )
    dfm = {
        "verdict": "prototype-fit-check-ready" if prototype_fit_ready else "needs-work",
        "print_quote_ready": print_quote_ready,
        "prototype_fit_ready": prototype_fit_ready,
        "tooling_ready": tooling_ready,
        "tooling_release_verdict": "blocked-until-final-r1-cad-and-production-dfm",
        "step_export_status": step_report["status"],
        "step_exported_count": step_report["exported_count"],
        "panel_gap_verdict": panel_gap["verdict"],
        "minimum_sampled_panel_gap_mm": panel_gap["minimum_sampled_panel_gap_mm"],
        "design_source_audit_verdict": source_audit["verdict"],
        "rules": {
            "min_print_wall_mm": params["fit"]["min_print_wall_mm"],
            "min_mold_wall_mm": params["fit"]["min_mold_wall_mm"],
            "draft_deg": params["fit"]["draft_deg"],
            "shrink_allowance_percent": params["fit"]["shrink_allowance_percent"],
        },
        "part_checks": dfm_rules,
    }
    (REVIEW_ROOT / "injection-molding-dfm.json").write_text(json.dumps(dfm, indent=2) + "\n")
    lines = [
        "# Unitree R1 Bodykit Manufacturing Readiness",
        "",
        f"Parts: {len(parts)}",
        f"Fit verdict: {fit['verdict']}",
        f"Simulator verdict: {fit.get('simulator_verdict', 'unknown')}",
        f"Production clearance verdict: {fit.get('production_fit_verdict', 'unknown')}",
        f"Panel gap verdict: {panel_gap['verdict']}",
        f"Face alignment verdict: {face_alignment['verdict']}",
        f"Parametric morphs applied: {params.get('_morph_application_report', {}).get('applied_count', 0)}",
        f"Minimum adjacent-interface clearance: {fit.get('minimum_non_mounted_body_clearance_mm')} mm",
        f"Minimum neck/head/face adjacent-interface clearance: {face_alignment.get('minimum_neck_head_face_non_mounted_clearance_mm')} mm",
        f"Minimum neck/head/face non-adjacent clearance: {face_alignment.get('minimum_neck_head_face_non_adjacent_clearance_mm')} mm",
        f"Minimum static non-adjacent clearance: {fit.get('minimum_non_adjacent_body_clearance_mm')} mm",
        f"Minimum operating dynamic non-adjacent sweep clearance: {fit.get('dynamic_joint_sweep', {}).get('minimum_non_adjacent_clearance_mm')} mm",
        f"Minimum mechanical dynamic non-adjacent sweep clearance: {fit.get('mechanical_dynamic_joint_sweep', {}).get('minimum_non_adjacent_clearance_mm')} mm",
        f"Clearance sampling: {fit.get('clearance_sampling', 'unknown')}",
        f"Articulated body distance: {fit.get('articulated_body_distance', 'unknown')}",
        f"Operating sweep fraction: {fit.get('dynamic_joint_sweep', {}).get('sweep_fraction', 'unknown')}",
        f"Mechanical sweep fraction: {fit.get('mechanical_dynamic_joint_sweep', {}).get('sweep_fraction', 'unknown')}",
        "",
        "Prototype: export STL/OBJ parts in `out/meshes/` for FDM service quoting.",
        "Production: preliminary STEP solids are in `out/step/`, but tool release still requires final R1 CAD/scan, shell offsets, mounts, ribs, inserts, parting lines, and production surfacing.",
        "",
        "DFM rules encoded:",
        f"- print wall >= {params['fit']['min_print_wall_mm']} mm",
        f"- molded wall >= {params['fit']['min_mold_wall_mm']} mm",
        f"- draft >= {params['fit']['draft_deg']} deg",
        f"- panel gap target {params['fit']['nominal_panel_gap_mm']} mm",
        f"- shrink allowance {params['fit']['shrink_allowance_percent']}%",
        "",
        "Open release gaps:",
        f"- STEP export status: {step_report['status']} ({step_report['exported_count']}/{len(parts)} parts).",
        f"- STEP blocked parts: {step_report.get('blocked_count', 0)}.",
        f"- Design source audit: {source_audit['verdict']} ({source_audit['shell_parts_checked']} shell parts checked).",
        f"- Parametric reconstruction audit: {reconstruction_audit['verdict']} ({reconstruction_audit['primitive_shell_count']} shell primitives still need loft reconstruction).",
        f"- Panel gap validation: {panel_gap['verdict']} ({panel_gap['pairs_below_gap_gate']} sampled nearby pairs below their seam/articulation gate).",
        f"- Worst adjacent/interface clearance: {json.dumps(fit.get('worst_non_mounted_body_clearance'), sort_keys=True)}.",
        f"- Worst non-adjacent static clearance: {json.dumps(fit.get('worst_non_adjacent_body_clearance'), sort_keys=True)}.",
        f"- Worst operating non-adjacent dynamic pose: {fit.get('dynamic_joint_sweep', {}).get('worst_non_adjacent_pose')}.",
        f"- Worst mechanical non-adjacent dynamic pose: {fit.get('mechanical_dynamic_joint_sweep', {}).get('worst_non_adjacent_pose')}.",
        "- Production fit clearance is a hard gate; visual-only MuJoCo loading is not production clearance evidence.",
        "- Collision-test MJCF is generated for inspection, but final release still needs simplified proxy collision meshes.",
        "- Final production fit needs real R1 mechanical CAD or a scan of the target chassis.",
        "",
        "Generated layout/DFM files:",
        "- `shapeways-print-layout.csv`",
        "- `injection-molding-dfm.json`",
        "- `step-export-report.json`",
        "- `design-source-audit.json`",
        "- `parametric-reconstruction-audit.json`",
        "- `base-cad-reconstruction-report.json`",
        "- `panel-gap-validation.json`",
        "- `part-review-report.json`",
        "- `face-alignment-validation.json`",
        "- `mechanical-stress-blockers.json`",
        "- `head-keepout-policy.json`",
        "- `parametric-morph-report.json`",
        "- `render-validation.json` when renders are generated",
        "- `reference-validation.json`",
    ]
    (REVIEW_ROOT / "manufacturing-readiness.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument("--skip-video", action="store_true")
    args = parser.parse_args()
    params = _load_params()
    morph_report = write_parametric_morph_report(params)
    concept_reference = write_concept_reference_report(params)
    parts = generate_meshes(params)
    step_report = export_step_solids(params)
    base_reconstruction = export_base_asset_reconstructions(params)
    mjcf = write_bodykit_mjcf(params, parts)
    fit = validate_fit(params, mjcf, parts)
    face_alignment = write_face_alignment_report(params, parts, fit, mjcf)
    panel_gap = validate_panel_gaps(params, mjcf, parts)
    source_audit = write_design_source_audit(params, parts)
    reconstruction_audit = write_parametric_reconstruction_audit(params, parts, step_report, base_reconstruction)
    part_review = write_part_review_report(parts, fit, panel_gap, face_alignment)
    assembled = export_assembled_bodykit(mjcf, parts)
    renders = [] if args.skip_render else render_review(mjcf)
    video = None if args.skip_video or args.skip_render else render_orbit_video(mjcf)
    render_validation = write_render_validation(renders, video)
    write_manufacturing_outputs(
        params,
        parts,
        fit,
        panel_gap,
        step_report,
        source_audit,
        reconstruction_audit,
        part_review,
        face_alignment,
    )
    stress_blockers = write_mechanical_stress_blocker_report(params, fit)
    print(
        json.dumps(
            {
                "mjcf": str(mjcf),
                "fit": fit["verdict"],
                "simulator": fit["simulator_verdict"],
                "production_clearance": fit["production_fit_verdict"],
                "panel_gap": panel_gap["verdict"],
                "part_review": part_review["verdict"],
                "face_alignment": face_alignment["verdict"],
                "renders": [str(p) for p in renders],
                "render_validation": render_validation["verdict"] if render_validation else None,
                "concept_reference": concept_reference["verdict"],
                "video": str(video) if video else None,
                "assembled": assembled,
                "step_export": step_report["status"],
                "base_cad_reconstruction": base_reconstruction["verdict"],
                "parametric_reconstruction": reconstruction_audit["verdict"],
                "parametric_morphs": morph_report["verdict"],
                "design_source_audit": source_audit["verdict"],
                "mechanical_stress": stress_blockers["verdict"],
            },
            indent=2,
        )
    )
    return 0 if fit["simulator_verdict"] == "pass" and source_audit["verdict"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
