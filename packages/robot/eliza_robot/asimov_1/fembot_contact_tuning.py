"""Collision-capsule tuning proof for the generated ASIMOV fembot MJCF."""

from __future__ import annotations

import json
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.collision_sweep import build_asimov1_collision_sweep_proof
from eliza_robot.asimov_1.fembot_mjcf import FEMBOT_MJCF_PATH, generate_fembot_mjcf
from eliza_robot.asimov_1.fembot_motion_validation import (
    _collision_geom_to_link,
    _contact_pair_summary,
)
from eliza_robot.asimov_1.fembot_structural import build_fembot_structural_sanity_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_OUTPUT_STL, ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import read_binary_stl_vertices

FEMBOT_CONTACT_TUNING_SCHEMA = "asimov-fembot-contact-tuning-proof-v1"
DEFAULT_COLLIDER_SCALE_CANDIDATES = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4)
DEFAULT_COLLIDER_LENGTH_SCALE_CANDIDATES = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4)
DEFAULT_STRUCTURAL_TARGET_LENGTH_SCALE_CANDIDATES = (0.8, 0.6, 0.5, 0.4)
DEFAULT_RECONSTRUCTION_TARGET_LENGTH_SCALE_CANDIDATES = (0.8, 0.6, 0.5, 0.4)
DEFAULT_LINK_SPECIFIC_FIT_BASE_LENGTH_SCALE_CANDIDATES = (0.5,)
DEFAULT_COLLIDER_SEGMENT_CANDIDATES = ((2, 0.4), (2, 0.5), (3, 0.4))
VISUAL_FIT_MAX_SAMPLE_VERTICES = 2500
VISUAL_FIT_MAX_MEAN_OUTSIDE_MARGIN_M = 0.035
VISUAL_FIT_MAX_OUTSIDE_FRACTION = 0.85
SAME_LIMB_DISTAL_CONTACT_EXCLUSIONS = (
    ("left_knee_link", "left_ankle_roll_link"),
    ("right_knee_link", "right_ankle_roll_link"),
)
DEFAULT_HIP_ROLL_INWARD_LIMIT_CANDIDATES = (0.30, 0.25, 0.20)
LINK_SPECIFIC_RESIDUAL_CAPSULE_FITS: dict[str, tuple[tuple[float, float, float], ...]] = {
    "waist_yaw_link_collision": ((0.0, 0.66, 1.0),),
    "neck_pitch_link_collision": ((0.40, 1.0, 0.9),),
    "left_elbow_link_collision": ((0.0, 0.35, 1.0), (0.55, 1.0, 1.0)),
    "right_elbow_link_collision": ((0.0, 0.35, 1.0), (0.55, 1.0, 1.0)),
    "left_hip_pitch_link_collision": ((0.0, 0.4, 1.0),),
    "right_hip_pitch_link_collision": ((0.0, 0.4, 1.0),),
    "left_shoulder_roll_link_collision": ((0.0, 0.65, 1.0),),
    "right_shoulder_roll_link_collision": ((0.0, 0.65, 1.0),),
}
VISUAL_ENVELOPE_PROXY_CAPSULES: dict[str, tuple[tuple[str, tuple[float, ...], float], ...]] = {
    "neck_pitch_link": (
        ("neck_pitch_link_collision_proxy_xneg", (-0.035, 0.0, -0.05, -0.035, 0.0, 0.13), 0.035),
        ("neck_pitch_link_collision_proxy_xmid", (0.015, 0.0, -0.05, 0.015, 0.0, 0.13), 0.035),
        ("neck_pitch_link_collision_proxy_xpos", (0.065, 0.0, -0.05, 0.065, 0.0, 0.13), 0.035),
        ("neck_pitch_link_collision_proxy_yneg", (0.015, -0.035, -0.05, 0.015, -0.035, 0.13), 0.03),
        ("neck_pitch_link_collision_proxy_ypos", (0.015, 0.035, -0.05, 0.015, 0.035, 0.13), 0.03),
    ),
    "left_knee_link": (
        ("left_knee_link_collision_proxy_xneg", (-0.04, 0.0, -0.30, -0.04, 0.0, 0.055), 0.032),
        ("left_knee_link_collision_proxy_xpos", (0.035, 0.0, -0.30, 0.035, 0.0, 0.055), 0.028),
    ),
    "right_knee_link": (
        ("right_knee_link_collision_proxy_xneg", (-0.04, 0.0, -0.30, -0.04, 0.0, 0.055), 0.032),
        ("right_knee_link_collision_proxy_xpos", (0.035, 0.0, -0.30, 0.035, 0.0, 0.055), 0.028),
    ),
}
PHYSICAL_VISUAL_REMEDIATION_CAPSULE_FITS: dict[str, tuple[tuple[float, float, float], ...]] = {
    "left_knee_link_collision": ((0.72, 1.0, 0.60),),
    "right_knee_link_collision": ((0.72, 1.0, 0.60),),
    "neck_pitch_link_collision": ((0.40, 1.0, 1.30),),
}
PHYSICAL_VISUAL_REMEDIATION_LOCAL_CAPSULES: dict[
    str,
    tuple[tuple[str, tuple[float, float, float, float, float, float], float], ...],
] = {
    "left_knee_link_collision": (
        ("center_distal_rail", (0.0, 0.0, -0.30, 0.0, 0.0, -0.08), 0.0154),
    ),
    "right_knee_link_collision": (
        ("center_distal_rail", (0.0, 0.0, -0.30, 0.0, 0.0, -0.08), 0.0154),
    ),
}


def _parse_size(raw: str | None) -> list[float]:
    if not raw:
        return []
    return [float(part) for part in raw.split()]


def _format_size(values: list[float]) -> str:
    return " ".join(f"{value:.12g}" for value in values)


def _parse_fromto(raw: str | None) -> tuple[np.ndarray, np.ndarray] | None:
    values = _parse_size(raw)
    if len(values) != 6:
        return None
    return np.asarray(values[:3], dtype=np.float64), np.asarray(values[3:], dtype=np.float64)


def _parse_quat(raw: str | None) -> np.ndarray:
    values = _parse_size(raw)
    if len(values) != 4:
        return np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
    quat = np.asarray(values, dtype=np.float64)
    norm = float(np.linalg.norm(quat))
    return quat / norm if norm > 0.0 else np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float64)


def _quat_matrix_wxyz(quat: np.ndarray) -> np.ndarray:
    w, x, y, z = quat
    return np.asarray(
        [
            [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
            [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
            [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def _sample_vertices(vertices: np.ndarray, max_count: int = VISUAL_FIT_MAX_SAMPLE_VERTICES) -> np.ndarray:
    if len(vertices) <= max_count:
        return vertices
    indices = np.linspace(0, len(vertices) - 1, max_count, dtype=np.int64)
    return vertices[indices]


def _capsule_distances(points: np.ndarray, start: np.ndarray, end: np.ndarray) -> np.ndarray:
    axis = end - start
    length_sq = float(axis @ axis)
    if length_sq <= 1.0e-18:
        return np.linalg.norm(points - start, axis=1)
    t = np.clip(((points - start) @ axis) / length_sq, 0.0, 1.0)
    closest = start + t[:, None] * axis
    return np.linalg.norm(points - closest, axis=1)


def _mesh_asset_files(root: ET.Element, source_mjcf: Path) -> dict[str, Path]:
    compiler = root.find("compiler")
    mesh_dir = ASIMOV_PARAM_OUTPUT_STL
    if compiler is not None and compiler.get("meshdir"):
        raw = Path(str(compiler.get("meshdir")))
        mesh_dir = raw if raw.is_absolute() else (source_mjcf.parent / raw)
    return {
        str(mesh.get("name")): mesh_dir / str(mesh.get("file"))
        for mesh in root.findall(".//asset/mesh")
        if mesh.get("name") and mesh.get("file")
    }


def _visual_geoms_by_body(body: ET.Element) -> list[ET.Element]:
    return [
        geom
        for geom in body.findall("geom")
        if geom.get("type") == "mesh"
        and (geom.get("class") == "visual" or str(geom.get("name", "")).endswith("_visual"))
        and geom.get("mesh")
    ]


def _transformed_visual_vertices(visual: ET.Element, mesh_assets: dict[str, Path]) -> np.ndarray | None:
    mesh_path = mesh_assets.get(str(visual.get("mesh")))
    if mesh_path is None or not mesh_path.is_file():
        return None
    vertices = _sample_vertices(read_binary_stl_vertices(mesh_path))
    rotation = _quat_matrix_wxyz(_parse_quat(visual.get("quat")))
    pos = np.asarray(_parse_size(visual.get("pos")) or [0.0, 0.0, 0.0], dtype=np.float64)
    if len(pos) != 3:
        pos = np.zeros(3, dtype=np.float64)
    return vertices @ rotation.T + pos


def _is_tunable_collision_geom(geom: ET.Element) -> bool:
    name = geom.get("name") or ""
    if not name:
        return False
    if name.startswith(("left_foot", "right_foot", "left_toe", "right_toe")):
        return False
    class_name = geom.get("class")
    return (
        class_name == "body_capsule"
        or name == "pelvis_collision"
        or "_collision" in name
    )


def _body_capsule_visual_fit(
    *,
    mjcf_path: Path,
) -> dict[str, Any]:
    tree = ET.parse(mjcf_path)
    root = tree.getroot()
    mesh_assets = _mesh_asset_files(root, mjcf_path)
    records: list[dict[str, Any]] = []
    missing_visuals: list[str] = []
    for body in root.findall(".//body"):
        visuals = _visual_geoms_by_body(body)
        visual_vertices = [
            vertices
            for visual in visuals
            if (vertices := _transformed_visual_vertices(visual, mesh_assets)) is not None
        ]
        collision_geoms = [geom for geom in body.findall("geom") if _is_tunable_collision_geom(geom)]
        if not collision_geoms:
            continue
        parsed_geoms = []
        for geom in collision_geoms:
            name = str(geom.get("name"))
            size = _parse_size(geom.get("size"))
            fromto = _parse_fromto(geom.get("fromto"))
            if not size or fromto is None:
                continue
            parsed_geoms.append((name, fromto[0], fromto[1], float(size[0])))
        if not parsed_geoms:
            continue
        first_name = parsed_geoms[0][0]
        link = _collision_geom_to_link(first_name)
        if not visual_vertices:
            missing_visuals.append(first_name)
            continue
        vertices = np.concatenate(visual_vertices, axis=0)
        signed_distances = []
        axis_distances = []
        for _name, start, end, radius in parsed_geoms:
            distances = _capsule_distances(vertices, start, end)
            axis_distances.append(distances)
            signed_distances.append(distances - radius)
        signed_distance = np.min(np.vstack(signed_distances), axis=0)
        nearest_axis_distance = np.min(np.vstack(axis_distances), axis=0)
        outside = signed_distance > 0.0
        positive_margin = signed_distance[outside]
        records.append(
            {
                "geom": first_name if len(parsed_geoms) == 1 else f"{body.get('name')}_collision_set",
                "link": link,
                "collision_geom_count": len(parsed_geoms),
                "collision_geoms": [record[0] for record in parsed_geoms],
                "visual_vertex_samples": int(len(vertices)),
                "capsule_radius_m": (
                    float(parsed_geoms[0][3])
                    if len(parsed_geoms) == 1
                    else float(max(record[3] for record in parsed_geoms))
                ),
                "capsule_length_m": (
                    float(np.linalg.norm(parsed_geoms[0][2] - parsed_geoms[0][1]))
                    if len(parsed_geoms) == 1
                    else float(sum(np.linalg.norm(record[2] - record[1]) for record in parsed_geoms))
                ),
                "mean_distance_to_axis_m": float(np.mean(nearest_axis_distance)),
                "max_distance_to_axis_m": float(np.max(nearest_axis_distance)),
                "outside_fraction": float(np.mean(outside)),
                "mean_outside_margin_m": (
                    float(np.mean(positive_margin)) if len(positive_margin) else 0.0
                ),
                "max_outside_margin_m": float(np.max(signed_distance)),
            }
        )

    worst_by_margin = max(records, key=lambda record: record["mean_outside_margin_m"], default=None)
    worst_by_fraction = max(records, key=lambda record: record["outside_fraction"], default=None)
    accepted = bool(
        records
        and not missing_visuals
        and max(record["mean_outside_margin_m"] for record in records)
        <= VISUAL_FIT_MAX_MEAN_OUTSIDE_MARGIN_M
        and max(record["outside_fraction"] for record in records)
        <= VISUAL_FIT_MAX_OUTSIDE_FRACTION
    )
    return {
        "schema": "asimov-fembot-collider-visual-fit-v1",
        "accepted": accepted,
        "model": (
            "sample generated STL vertices in each body frame and compare them to "
            "the scaled MuJoCo body-capsule collision radius"
        ),
        "thresholds": {
            "max_mean_outside_margin_m": VISUAL_FIT_MAX_MEAN_OUTSIDE_MARGIN_M,
            "max_outside_fraction": VISUAL_FIT_MAX_OUTSIDE_FRACTION,
            "max_sample_vertices_per_visual": VISUAL_FIT_MAX_SAMPLE_VERTICES,
        },
        "summary": {
            "geom_count": len(records),
            "missing_visual_geom_count": len(missing_visuals),
            "worst_mean_outside_margin_m": (
                worst_by_margin["mean_outside_margin_m"] if worst_by_margin else None
            ),
            "worst_mean_outside_margin_geom": worst_by_margin["geom"] if worst_by_margin else None,
            "worst_outside_fraction": (
                worst_by_fraction["outside_fraction"] if worst_by_fraction else None
            ),
            "worst_outside_fraction_geom": worst_by_fraction["geom"] if worst_by_fraction else None,
            "accepted": accepted,
        },
        "missing_visual_geoms": missing_visuals,
        "geoms": records,
    }


def _scale_body_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    scale: float,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))
    scaled_geoms = []
    for geom in root.findall(".//geom"):
        name = geom.get("name")
        class_name = geom.get("class")
        is_body_capsule = class_name == "body_capsule"
        is_body_collision = bool(name and name.endswith("_link_collision"))
        is_pelvis = name == "pelvis_collision"
        if not (is_body_capsule or is_body_collision or is_pelvis):
            continue
        if name and (name.startswith("left_foot") or name.startswith("right_foot")):
            continue
        if name and (name.startswith("left_toe") or name.startswith("right_toe")):
            continue
        size = _parse_size(geom.get("size"))
        if not size:
            continue
        scaled = [value * scale for value in size]
        geom.set("size", _format_size(scaled))
        scaled_geoms.append(
            {
                "name": name,
                "class": class_name,
                "source_size_m": size,
                "output_size_m": scaled,
            }
        )

    for default in root.findall(".//default"):
        if default.get("class") != "body_capsule":
            continue
        geom = default.find("geom")
        if geom is None:
            continue
        size = _parse_size(geom.get("size"))
        if not size:
            continue
        scaled = [value * scale for value in size]
        geom.set("size", _format_size(scaled))
        scaled_geoms.append(
            {
                "name": "default:body_capsule",
                "class": "body_capsule",
                "source_size_m": size,
                "output_size_m": scaled,
            }
        )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "scale": float(scale),
        "scaled_geom_count": len(scaled_geoms),
        "scaled_geoms": scaled_geoms,
    }


def _shorten_body_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    length_scale: float,
    target_links: set[str] | None = None,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))
    scaled_geoms = []
    for geom in root.findall(".//geom"):
        name = geom.get("name")
        link = _collision_geom_to_link(str(name or ""))
        if target_links is not None and (link is None or link not in target_links):
            continue
        class_name = geom.get("class")
        is_body_capsule = class_name == "body_capsule"
        is_body_collision = bool(name and name.endswith("_link_collision"))
        is_pelvis = name == "pelvis_collision"
        if not (is_body_capsule or is_body_collision or is_pelvis):
            continue
        if name and (name.startswith("left_foot") or name.startswith("right_foot")):
            continue
        if name and (name.startswith("left_toe") or name.startswith("right_toe")):
            continue
        endpoints = _parse_fromto(geom.get("fromto"))
        if endpoints is None:
            continue
        start, end = endpoints
        midpoint = (start + end) * 0.5
        half = (end - start) * 0.5 * float(length_scale)
        output_start = midpoint - half
        output_end = midpoint + half
        geom.set("fromto", _format_size([*output_start.tolist(), *output_end.tolist()]))
        scaled_geoms.append(
            {
                "name": name,
                "class": class_name,
                "link": link,
                "source_fromto_m": [*start.tolist(), *end.tolist()],
                "output_fromto_m": [*output_start.tolist(), *output_end.tolist()],
            }
        )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "length_scale": float(length_scale),
        "target_links": sorted(target_links) if target_links is not None else None,
        "scaled_geom_count": len(scaled_geoms),
        "scaled_geoms": scaled_geoms,
    }


def _segment_body_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    segment_count: int,
    segment_length_scale: float,
    radius_scale: float = 1.0,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))
    scaled_geoms = []
    for body in root.findall(".//body"):
        source_geoms = [geom for geom in body.findall("geom") if _is_tunable_collision_geom(geom)]
        for geom in source_geoms:
            name = str(geom.get("name"))
            endpoints = _parse_fromto(geom.get("fromto"))
            size = _parse_size(geom.get("size"))
            if endpoints is None or not size:
                continue
            body.remove(geom)
            start, end = endpoints
            axis = end - start
            output_size = [float(size[0]) * float(radius_scale), *size[1:]]
            for segment_index in range(segment_count):
                segment_start_t = float(segment_index) / float(segment_count)
                segment_end_t = float(segment_index + 1) / float(segment_count)
                segment_mid_t = (segment_start_t + segment_end_t) * 0.5
                segment_half_t = (segment_end_t - segment_start_t) * float(segment_length_scale) * 0.5
                output_start = start + axis * (segment_mid_t - segment_half_t)
                output_end = start + axis * (segment_mid_t + segment_half_t)
                segment_name = f"{name}_seg{segment_index}"
                ET.SubElement(
                    body,
                    "geom",
                    {
                        "name": segment_name,
                        "class": "body_capsule",
                        "fromto": _format_size([*output_start.tolist(), *output_end.tolist()]),
                        "size": _format_size(output_size),
                    },
                )
                scaled_geoms.append(
                    {
                        "name": segment_name,
                        "source_name": name,
                        "class": geom.get("class"),
                        "source_fromto_m": [*start.tolist(), *end.tolist()],
                        "output_fromto_m": [*output_start.tolist(), *output_end.tolist()],
                        "source_size_m": size,
                        "output_size_m": output_size,
                    }
                )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "segment_count": int(segment_count),
        "segment_length_scale": float(segment_length_scale),
        "radius_scale": float(radius_scale),
        "scaled_geom_count": len(scaled_geoms),
        "scaled_geoms": scaled_geoms,
    }


def _fit_link_specific_residual_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    reconstruction_plan: list[dict[str, Any]],
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))

    planned_geoms = {
        str(geom)
        for record in reconstruction_plan
        for geom in record.get("geom_pair", [])
        if geom
    }
    scaled_geoms = []
    for body in root.findall(".//body"):
        for geom in list(body.findall("geom")):
            name = str(geom.get("name") or "")
            fits = LINK_SPECIFIC_RESIDUAL_CAPSULE_FITS.get(name)
            if name not in planned_geoms or not fits:
                continue
            endpoints = _parse_fromto(geom.get("fromto"))
            size = _parse_size(geom.get("size"))
            if endpoints is None or not size:
                continue
            body.remove(geom)
            start, end = endpoints
            axis = end - start
            for fit_index, (start_t, end_t, radius_scale) in enumerate(fits):
                output_start = start + axis * float(start_t)
                output_end = start + axis * float(end_t)
                output_size = [float(size[0]) * float(radius_scale), *size[1:]]
                fit_name = f"{name}_fit{fit_index}"
                ET.SubElement(
                    body,
                    "geom",
                    {
                        "name": fit_name,
                        "class": "body_capsule",
                        "fromto": _format_size([*output_start.tolist(), *output_end.tolist()]),
                        "size": _format_size(output_size),
                    },
                )
                scaled_geoms.append(
                    {
                        "name": fit_name,
                        "source_name": name,
                        "link": _collision_geom_to_link(name),
                        "source_fromto_m": [*start.tolist(), *end.tolist()],
                        "output_fromto_m": [*output_start.tolist(), *output_end.tolist()],
                        "source_size_m": size,
                        "output_size_m": output_size,
                        "axis_start_fraction": float(start_t),
                        "axis_end_fraction": float(end_t),
                        "radius_scale": float(radius_scale),
                    }
                )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "fit_geom_count": len(scaled_geoms),
        "scaled_geom_count": len(scaled_geoms),
        "scaled_geoms": scaled_geoms,
    }


def _add_visual_envelope_proxy_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    floor_contact_enabled: bool = False,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))

    if floor_contact_enabled:
        floor = root.find(".//geom[@name='floor']")
        if floor is not None:
            floor.set("contype", "1")
            floor.set("conaffinity", "3")

    proxy_geoms = []
    for body in root.findall(".//body"):
        body_name = str(body.get("name") or "")
        for name, fromto, radius in VISUAL_ENVELOPE_PROXY_CAPSULES.get(body_name, ()):
            ET.SubElement(
                body,
                "geom",
                {
                    "name": name,
                        "class": "body_capsule",
                        "fromto": _format_size(list(fromto)),
                        "size": _format_size([float(radius)]),
                        "contype": "2" if floor_contact_enabled else "0",
                        "conaffinity": "0",
                    },
                )
            proxy_geoms.append(
                {
                    "name": name,
                    "body": body_name,
                    "link": _collision_geom_to_link(name),
                    "fromto_m": list(fromto),
                    "radius_m": float(radius),
                    "contact_enabled": floor_contact_enabled,
                    "floor_contact_enabled": floor_contact_enabled,
                    "self_contact_enabled": False,
                }
            )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "proxy_geom_count": len(proxy_geoms),
        "scaled_geom_count": len(proxy_geoms),
        "fit_geom_count": len(proxy_geoms),
        "contact_enabled": floor_contact_enabled,
        "floor_contact_enabled": floor_contact_enabled,
        "self_contact_enabled": False,
        "scaled_geoms": proxy_geoms,
    }


def _add_physical_visual_envelope_capsules(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))

    physical_geoms = []
    for body in root.findall(".//body"):
        body_name = str(body.get("name") or "")
        for name, fromto, radius in VISUAL_ENVELOPE_PROXY_CAPSULES.get(body_name, ()):
            physical_name = name.replace("_proxy_", "_physical_")
            ET.SubElement(
                body,
                "geom",
                {
                    "name": physical_name,
                    "class": "body_capsule",
                    "fromto": _format_size(list(fromto)),
                    "size": _format_size([float(radius)]),
                },
            )
            physical_geoms.append(
                {
                    "name": physical_name,
                    "body": body_name,
                    "link": _collision_geom_to_link(physical_name),
                    "fromto_m": list(fromto),
                    "radius_m": float(radius),
                    "contact_enabled": True,
                    "floor_contact_enabled": True,
                    "self_contact_enabled": True,
                }
            )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "physical_envelope_geom_count": len(physical_geoms),
        "scaled_geom_count": len(physical_geoms),
        "fit_geom_count": len(physical_geoms),
        "contact_enabled": True,
        "floor_contact_enabled": True,
        "self_contact_enabled": True,
        "scaled_geoms": physical_geoms,
    }


def _add_contact_exclusions(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    body_pairs: tuple[tuple[str, str], ...],
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    contact = root.find("contact")
    if contact is None:
        contact = ET.SubElement(root, "contact")
    existing = {
        (str(exclude.get("body1") or ""), str(exclude.get("body2") or ""))
        for exclude in contact.findall("exclude")
    }

    added: list[dict[str, str]] = []
    for body1, body2 in body_pairs:
        if (body1, body2) in existing or (body2, body1) in existing:
            continue
        ET.SubElement(contact, "exclude", {"body1": body1, "body2": body2})
        existing.add((body1, body2))
        added.append({"body1": body1, "body2": body2})

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "contact_exclusion_count": len(added),
        "contact_exclusions": added,
        "contact_enabled": True,
        "floor_contact_enabled": True,
        "self_contact_enabled": True,
    }


def _limit_inward_hip_roll(
    *,
    source_mjcf: Path,
    output_mjcf: Path,
    inward_limit_rad: float,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    updated = []
    for joint in root.findall(".//joint"):
        name = str(joint.get("name") or "")
        if name not in {"left_hip_roll_joint", "right_hip_roll_joint"}:
            continue
        values = _parse_size(joint.get("range"))
        if len(values) != 2:
            continue
        source_range = list(values)
        if name == "left_hip_roll_joint":
            values[0] = max(values[0], -float(inward_limit_rad))
        else:
            values[1] = min(values[1], float(inward_limit_rad))
        joint.set("range", _format_size(values))
        updated.append(
            {
                "joint": name,
                "source_range_rad": source_range,
                "output_range_rad": list(values),
            }
        )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "hip_roll_inward_limit_rad": float(inward_limit_rad),
        "limited_joint_count": len(updated),
        "limited_joints": updated,
    }


def _add_physical_visual_remediation_capsules(
    *,
    source_mjcf: Path,
    reference_mjcf: Path,
    output_mjcf: Path,
) -> dict[str, Any]:
    tree = ET.parse(source_mjcf)
    root = tree.getroot()
    compiler = root.find("compiler")
    if compiler is not None:
        meshdir = compiler.get("meshdir")
        if meshdir:
            meshdir_path = Path(meshdir)
            if not meshdir_path.is_absolute():
                meshdir_path = (source_mjcf.parent / meshdir_path).resolve()
            compiler.set("meshdir", str(meshdir_path))

    reference_geoms: dict[str, tuple[np.ndarray, np.ndarray, list[float]]] = {}
    reference_root = ET.parse(reference_mjcf).getroot()
    for geom in reference_root.findall(".//geom"):
        name = str(geom.get("name") or "")
        endpoints = _parse_fromto(geom.get("fromto"))
        size = _parse_size(geom.get("size"))
        if name and endpoints is not None and size:
            reference_geoms[name] = (endpoints[0], endpoints[1], size)

    body_by_geom = {
        str(geom.get("name") or ""): body
        for body in root.findall(".//body")
        for geom in body.findall("geom")
    }
    remediation_geoms = []
    for source_name, fits in PHYSICAL_VISUAL_REMEDIATION_CAPSULE_FITS.items():
        source = reference_geoms.get(source_name)
        body = body_by_geom.get(source_name)
        if body is None:
            body = body_by_geom.get(f"{source_name}_fit0")
        if source is None or body is None:
            continue
        start, end, size = source
        axis = end - start
        for fit_index, (start_t, end_t, radius_scale) in enumerate(fits):
            output_start = start + axis * float(start_t)
            output_end = start + axis * float(end_t)
            output_size = [float(size[0]) * float(radius_scale), *size[1:]]
            fit_name = f"{source_name}_visual_fit{fit_index}"
            preexisting = body.find(f"geom[@name='{fit_name}']") is not None
            if not preexisting:
                ET.SubElement(
                    body,
                    "geom",
                    {
                        "name": fit_name,
                        "class": "body_capsule",
                        "fromto": _format_size([*output_start.tolist(), *output_end.tolist()]),
                        "size": _format_size(output_size),
                    },
                )
            remediation_geoms.append(
                {
                    "name": fit_name,
                    "source_name": source_name,
                    "link": _collision_geom_to_link(source_name),
                    "source_fromto_m": [*start.tolist(), *end.tolist()],
                    "output_fromto_m": [*output_start.tolist(), *output_end.tolist()],
                    "source_size_m": size,
                    "output_size_m": output_size,
                    "axis_start_fraction": float(start_t),
                    "axis_end_fraction": float(end_t),
                    "radius_scale": float(radius_scale),
                    "contact_enabled": True,
                    "preexisting": preexisting,
                }
            )
    for source_name, local_capsules in PHYSICAL_VISUAL_REMEDIATION_LOCAL_CAPSULES.items():
        body = body_by_geom.get(source_name)
        if body is None:
            body = body_by_geom.get(f"{source_name}_fit0")
        if body is None:
            continue
        for local_name, fromto, radius in local_capsules:
            fit_name = f"{source_name}_visual_{local_name}"
            preexisting = body.find(f"geom[@name='{fit_name}']") is not None
            if not preexisting:
                ET.SubElement(
                    body,
                    "geom",
                    {
                        "name": fit_name,
                        "class": "body_capsule",
                        "fromto": _format_size(list(fromto)),
                        "size": _format_size([float(radius)]),
                    },
                )
            remediation_geoms.append(
                {
                    "name": fit_name,
                    "source_name": source_name,
                    "link": _collision_geom_to_link(source_name),
                    "fromto_m": list(fromto),
                    "radius_m": float(radius),
                    "contact_enabled": True,
                    "preexisting": preexisting,
                }
            )

    output_mjcf.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(tree, space="  ")
    tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    return {
        "mjcf": str(output_mjcf),
        "mjcf_sha256": sha256_file(output_mjcf),
        "remediation_geom_count": len(remediation_geoms),
        "scaled_geom_count": len(remediation_geoms),
        "fit_geom_count": len(remediation_geoms),
        "contact_enabled": True,
        "scaled_geoms": remediation_geoms,
    }


def _sweep_record(
    *,
    mjcf_path: Path,
    scale: float | None,
    length_scale: float | None = None,
    segment_count: int | None = None,
    segment_length_scale: float | None = None,
    target_links: set[str] | None = None,
    strategy: str = "radius_scale",
    body_groups: list[dict[str, Any]],
    scaled_model: dict[str, Any],
    structural_report: dict[str, Any],
) -> dict[str, Any]:
    collision = build_asimov1_collision_sweep_proof(mjcf_path=mjcf_path)
    contact_pairs = _contact_pair_summary(
        collision,
        body_groups=body_groups,
        structural_report=structural_report,
    )
    visual_fit = _body_capsule_visual_fit(mjcf_path=mjcf_path)
    structural_risk_pairs = [
        pair for pair in contact_pairs if pair["structural_remediation_contact_risk"]
    ]
    structural_risk_links = sorted(
        {
            link
            for pair in structural_risk_pairs
            for link in pair["structural_remediation_links"]
        }
    )
    return {
        "strategy": strategy,
        "scale": float(scale) if scale is not None else None,
        "length_scale": float(length_scale) if length_scale is not None else None,
        "segment_count": int(segment_count) if segment_count is not None else None,
        "segment_length_scale": (
            float(segment_length_scale) if segment_length_scale is not None else None
        ),
        "target_links": sorted(target_links) if target_links is not None else None,
        "ok": bool(collision.get("ok")),
        "accepted": bool(collision.get("accepted")),
        "load": collision.get("load", {}),
        "scaled_model": {
            "mjcf_sha256": scaled_model.get("mjcf_sha256"),
            "scaled_geom_count": scaled_model.get("scaled_geom_count"),
            "fit_geom_count": scaled_model.get("fit_geom_count"),
            "proxy_geom_count": scaled_model.get("proxy_geom_count"),
            "remediation_geom_count": scaled_model.get("remediation_geom_count"),
            "physical_envelope_geom_count": scaled_model.get("physical_envelope_geom_count"),
            "contact_exclusion_count": scaled_model.get("contact_exclusion_count"),
            "hip_roll_inward_limit_rad": scaled_model.get("hip_roll_inward_limit_rad"),
            "limited_joint_count": scaled_model.get("limited_joint_count"),
            "contact_enabled": scaled_model.get("contact_enabled"),
            "floor_contact_enabled": scaled_model.get("floor_contact_enabled"),
            "self_contact_enabled": scaled_model.get("self_contact_enabled"),
        },
        "summary": {
            "samples": collision.get("summary", {}).get("samples", 0),
            "unapproved_contact_samples": collision.get("summary", {}).get(
                "unapproved_contact_samples",
                0,
            ),
            "unapproved_contact_count": collision.get("summary", {}).get(
                "unapproved_contact_count",
                0,
            ),
            "contact_pair_count": len(contact_pairs),
            "minimum_unapproved_distance_m": collision.get("summary", {}).get(
                "minimum_unapproved_distance_m",
            ),
            "worst_sample": collision.get("summary", {}).get("worst_sample"),
            "worst_contact_pair": contact_pairs[0]["geom_pair"] if contact_pairs else None,
            "structural_remediation_contact_risk_pairs": len(structural_risk_pairs),
            "structural_remediation_contact_risk_links": len(structural_risk_links),
            "structural_remediation_contact_risk_link_names": structural_risk_links,
            "structural_remediation_contact_worsened_pairs": sum(
                1
                for pair in structural_risk_pairs
                if float(pair["structural_remediation_growth_allowance_m"]) > 0.0
            ),
            "visual_fit_accepted": visual_fit["accepted"],
            "visual_fit_worst_mean_outside_margin_m": visual_fit["summary"][
                "worst_mean_outside_margin_m"
            ],
            "visual_fit_worst_outside_fraction": visual_fit["summary"][
                "worst_outside_fraction"
            ],
        },
        "contact_pairs": contact_pairs,
        "visual_fit": visual_fit,
    }


def _collider_reconstruction_plan(
    *,
    targeted_length_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    structural_clean = [
        record
        for record in targeted_length_records
        if int(record["summary"]["structural_remediation_contact_risk_pairs"]) == 0
    ]
    source = min(
        structural_clean,
        key=lambda record: (
            int(record["summary"]["unapproved_contact_count"]),
            float(record["summary"]["visual_fit_worst_mean_outside_margin_m"] or float("inf")),
            float(record["length_scale"] if record["length_scale"] is not None else 0.0),
        ),
        default=None,
    )
    if source is None:
        return []
    records = []
    for pair in source.get("contact_pairs", []):
        links = [link for link in pair.get("links", []) if link]
        groups = [group for group in pair.get("body_groups", []) if group]
        involves_structural = bool(pair.get("structural_remediation_contact_risk"))
        records.append(
            {
                "source_strategy": source["strategy"],
                "source_length_scale": source["length_scale"],
                "geom_pair": pair["geom_pair"],
                "links": links,
                "body_groups": groups,
                "minimum_distance_m": pair.get("minimum_distance_m"),
                "sample_labels": pair.get("sample_labels", []),
                "involves_structural_remediation_link": involves_structural,
                "recommended_reconstruction": (
                    "replace this residual pair with link-specific multi-capsule or "
                    "convex collider geometry fitted to generated STL/STEP surfaces; "
                    "preserve the current visual envelope and rerun MuJoCo sweep"
                ),
                "accepted": False,
            }
        )
    records.sort(
        key=lambda record: (
            float(record["minimum_distance_m"])
            if record["minimum_distance_m"] is not None
            else 0.0,
            record["geom_pair"],
        )
    )
    return records


def _visual_fit_remediation_plan(
    *,
    source_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    contact_clean = [record for record in source_records if record.get("accepted")]
    source = min(
        contact_clean,
        key=lambda record: (
            int(record["summary"]["contact_pair_count"]),
            float(record["summary"]["visual_fit_worst_mean_outside_margin_m"] or float("inf")),
            float(record["summary"]["visual_fit_worst_outside_fraction"] or float("inf")),
            str(record["strategy"]),
        ),
        default=None,
    )
    if source is None:
        return []

    records = []
    for geom in source.get("visual_fit", {}).get("geoms", []):
        outside_fraction = float(geom["outside_fraction"])
        mean_margin = float(geom["mean_outside_margin_m"])
        fraction_excess = max(0.0, outside_fraction - VISUAL_FIT_MAX_OUTSIDE_FRACTION)
        mean_margin_excess = max(0.0, mean_margin - VISUAL_FIT_MAX_MEAN_OUTSIDE_MARGIN_M)
        if fraction_excess <= 0.0 and mean_margin_excess <= 0.0:
            continue
        link = geom.get("link")
        records.append(
            {
                "source_strategy": source["strategy"],
                "source_length_scale": source["length_scale"],
                "geom": geom["geom"],
                "link": link,
                "collision_geom_count": geom["collision_geom_count"],
                "collision_geoms": geom["collision_geoms"],
                "outside_fraction": outside_fraction,
                "outside_fraction_limit": VISUAL_FIT_MAX_OUTSIDE_FRACTION,
                "outside_fraction_excess": fraction_excess,
                "mean_outside_margin_m": mean_margin,
                "mean_outside_margin_limit_m": VISUAL_FIT_MAX_MEAN_OUTSIDE_MARGIN_M,
                "mean_outside_margin_excess_m": mean_margin_excess,
                "max_outside_margin_m": geom["max_outside_margin_m"],
                "recommended_reconstruction": (
                    "add link-local visual-envelope collider coverage fitted to generated "
                    "STL/STEP cross sections, then rerun MuJoCo contact and visual-fit sweeps"
                ),
                "accepted": False,
            }
        )
    records.sort(
        key=lambda record: (
            float(record["mean_outside_margin_excess_m"]),
            float(record["outside_fraction_excess"]),
            float(record["max_outside_margin_m"]),
        ),
        reverse=True,
    )
    return records


def build_fembot_contact_tuning_proof(
    body_groups: list[dict[str, Any]],
    *,
    scale_candidates: tuple[float, ...] = DEFAULT_COLLIDER_SCALE_CANDIDATES,
    length_scale_candidates: tuple[float, ...] = DEFAULT_COLLIDER_LENGTH_SCALE_CANDIDATES,
    structural_target_length_scale_candidates: tuple[float, ...] = (
        DEFAULT_STRUCTURAL_TARGET_LENGTH_SCALE_CANDIDATES
    ),
    reconstruction_target_length_scale_candidates: tuple[float, ...] = (
        DEFAULT_RECONSTRUCTION_TARGET_LENGTH_SCALE_CANDIDATES
    ),
    link_specific_fit_base_length_scale_candidates: tuple[float, ...] = (
        DEFAULT_LINK_SPECIFIC_FIT_BASE_LENGTH_SCALE_CANDIDATES
    ),
    segment_candidates: tuple[tuple[int, float], ...] = DEFAULT_COLLIDER_SEGMENT_CANDIDATES,
    hip_roll_inward_limit_candidates: tuple[float, ...] = (
        DEFAULT_HIP_ROLL_INWARD_LIMIT_CANDIDATES
    ),
    fembot_mjcf_report: dict[str, Any] | None = None,
    structural_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fembot_mjcf = fembot_mjcf_report
    structural = structural_report or build_fembot_structural_sanity_proof(body_groups)
    structural_target_links = {
        str(record.get("link", "")).upper()
        for record in structural.get("structural_remediation_thinness_impact", [])
        if record.get("link")
    }
    radius_records = []
    length_records = []
    targeted_length_records = []
    reconstruction_targeted_length_records = []
    link_specific_fit_records = []
    physical_visual_remediation_records = []
    visual_envelope_proxy_records = []
    floor_contact_proxy_records = []
    physical_envelope_records = []
    physical_envelope_exclusion_records = []
    hip_roll_limit_records = []
    segment_records = []
    with tempfile.TemporaryDirectory(prefix="asimov-fembot-contact-tuning-") as tmp:
        tmp_path = Path(tmp)
        if fembot_mjcf is None:
            fembot_mjcf = generate_fembot_mjcf(
                output_mjcf=FEMBOT_MJCF_PATH.with_name(
                    "asimov_fembot_contact_tuning_source.xml"
                ),
                promote_contact_tuned_colliders=False,
            )
        source_mjcf = Path(str(fembot_mjcf.get("output", {}).get("mjcf", "")))
        for scale in scale_candidates:
            output_mjcf = tmp_path / f"asimov_fembot_collision_scale_{scale:.3f}.xml"
            scaled_model = _scale_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=output_mjcf,
                scale=float(scale),
            )
            radius_records.append(
                _sweep_record(
                    mjcf_path=output_mjcf,
                    scale=float(scale),
                    strategy="radius_scale",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )
        for length_scale in length_scale_candidates:
            output_mjcf = tmp_path / f"asimov_fembot_collision_length_{length_scale:.3f}.xml"
            scaled_model = _shorten_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=output_mjcf,
                length_scale=float(length_scale),
            )
            length_records.append(
                _sweep_record(
                    mjcf_path=output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    strategy="length_scale",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )
        for length_scale in structural_target_length_scale_candidates:
            output_mjcf = tmp_path / (
                f"asimov_fembot_collision_structural_length_{length_scale:.3f}.xml"
            )
            scaled_model = _shorten_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=output_mjcf,
                length_scale=float(length_scale),
                target_links=structural_target_links,
            )
            targeted_length_records.append(
                _sweep_record(
                    mjcf_path=output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    target_links=structural_target_links,
                    strategy="structural_target_length_scale",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )
        preliminary_reconstruction_plan = _collider_reconstruction_plan(
            targeted_length_records=targeted_length_records
        )
        reconstruction_target_links = structural_target_links | {
            str(link).upper()
            for record in preliminary_reconstruction_plan
            for link in record.get("links", [])
            if link
        }
        for length_scale in reconstruction_target_length_scale_candidates:
            output_mjcf = tmp_path / (
                f"asimov_fembot_collision_reconstruction_length_{length_scale:.3f}.xml"
            )
            scaled_model = _shorten_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=output_mjcf,
                length_scale=float(length_scale),
                target_links=reconstruction_target_links,
            )
            reconstruction_targeted_length_records.append(
                _sweep_record(
                    mjcf_path=output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    target_links=reconstruction_target_links,
                    strategy="reconstruction_target_length_scale",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )
        for length_scale in link_specific_fit_base_length_scale_candidates:
            structural_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_link_fit_structural_{length_scale:.3f}.xml"
            )
            fitted_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_link_fit_{length_scale:.3f}.xml"
            )
            structural_model = _shorten_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=structural_output_mjcf,
                length_scale=float(length_scale),
                target_links=structural_target_links,
            )
            fit_model = _fit_link_specific_residual_capsules(
                source_mjcf=structural_output_mjcf,
                output_mjcf=fitted_output_mjcf,
                reconstruction_plan=preliminary_reconstruction_plan,
            )
            scaled_model = {
                **fit_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "fit_geom_count": fit_model["fit_geom_count"],
                "scaled_geom_count": (
                    int(structural_model["scaled_geom_count"])
                    + int(fit_model["scaled_geom_count"])
                ),
                "scaled_geoms": [
                    *structural_model["scaled_geoms"],
                    *fit_model["scaled_geoms"],
                ],
            }
            link_specific_fit_records.append(
                _sweep_record(
                    mjcf_path=fitted_output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    target_links=reconstruction_target_links,
                    strategy="link_specific_residual_fit",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )
            physical_visual_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_physical_visual_{length_scale:.3f}.xml"
            )
            physical_visual_model = _add_physical_visual_remediation_capsules(
                source_mjcf=fitted_output_mjcf,
                reference_mjcf=source_mjcf,
                output_mjcf=physical_visual_output_mjcf,
            )
            scaled_physical_visual_model = {
                **physical_visual_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "residual_fit_geom_count": fit_model["fit_geom_count"],
                "scaled_geom_count": (
                    int(structural_model["scaled_geom_count"])
                    + int(fit_model["scaled_geom_count"])
                    + int(physical_visual_model["scaled_geom_count"])
                ),
                "fit_geom_count": (
                    int(fit_model["fit_geom_count"])
                    + int(physical_visual_model["fit_geom_count"])
                ),
                "remediation_geom_count": physical_visual_model["remediation_geom_count"],
                "scaled_geoms": [
                    *structural_model["scaled_geoms"],
                    *fit_model["scaled_geoms"],
                    *physical_visual_model["scaled_geoms"],
                ],
            }
            physical_visual_remediation_records.append(
                _sweep_record(
                    mjcf_path=physical_visual_output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    target_links=reconstruction_target_links,
                    strategy="physical_visual_remediation",
                    body_groups=body_groups,
                    scaled_model=scaled_physical_visual_model,
                    structural_report=structural,
                )
            )
            proxy_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_visual_proxy_{length_scale:.3f}.xml"
            )
            proxy_model = _add_visual_envelope_proxy_capsules(
                source_mjcf=fitted_output_mjcf,
                output_mjcf=proxy_output_mjcf,
            )
            scaled_proxy_model = {
                **proxy_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "residual_fit_geom_count": fit_model["fit_geom_count"],
                "scaled_geom_count": (
                    int(structural_model["scaled_geom_count"])
                    + int(fit_model["scaled_geom_count"])
                    + int(proxy_model["scaled_geom_count"])
                ),
                "fit_geom_count": (
                    int(fit_model["fit_geom_count"])
                    + int(proxy_model["fit_geom_count"])
                ),
                "proxy_geom_count": proxy_model["proxy_geom_count"],
                "scaled_geoms": [
                    *structural_model["scaled_geoms"],
                    *fit_model["scaled_geoms"],
                    *proxy_model["scaled_geoms"],
                ],
            }
            proxy_record = _sweep_record(
                mjcf_path=proxy_output_mjcf,
                scale=None,
                length_scale=float(length_scale),
                target_links=reconstruction_target_links,
                strategy="visual_envelope_proxy",
                body_groups=body_groups,
                scaled_model=scaled_proxy_model,
                structural_report=structural,
            )
            proxy_record["production_accepted"] = False
            proxy_record["acceptance_blocker"] = (
                "visual envelope proxy capsules have contype=0 and conaffinity=0; "
                "they prove required local coverage but are not physical colliders"
            )
            visual_envelope_proxy_records.append(proxy_record)

            floor_proxy_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_floor_proxy_{length_scale:.3f}.xml"
            )
            floor_proxy_model = _add_visual_envelope_proxy_capsules(
                source_mjcf=fitted_output_mjcf,
                output_mjcf=floor_proxy_output_mjcf,
                floor_contact_enabled=True,
            )
            scaled_floor_proxy_model = {
                **floor_proxy_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "residual_fit_geom_count": fit_model["fit_geom_count"],
                "scaled_geom_count": (
                    int(structural_model["scaled_geom_count"])
                    + int(fit_model["scaled_geom_count"])
                    + int(floor_proxy_model["scaled_geom_count"])
                ),
                "fit_geom_count": (
                    int(fit_model["fit_geom_count"])
                    + int(floor_proxy_model["fit_geom_count"])
                ),
                "proxy_geom_count": floor_proxy_model["proxy_geom_count"],
                "scaled_geoms": [
                    *structural_model["scaled_geoms"],
                    *fit_model["scaled_geoms"],
                    *floor_proxy_model["scaled_geoms"],
                ],
            }
            floor_proxy_record = _sweep_record(
                mjcf_path=floor_proxy_output_mjcf,
                scale=None,
                length_scale=float(length_scale),
                target_links=reconstruction_target_links,
                strategy="visual_envelope_floor_contact_proxy",
                body_groups=body_groups,
                scaled_model=scaled_floor_proxy_model,
                structural_report=structural,
            )
            floor_proxy_record["production_accepted"] = False
            floor_proxy_record["acceptance_blocker"] = (
                "visual envelope floor-contact proxy capsules use contype=2/conaffinity=0 "
                "with floor conaffinity=3; they can contact floor/external bit 2, but "
                "self-contact remains disabled and is not a production self-collider"
            )
            floor_contact_proxy_records.append(floor_proxy_record)

            physical_envelope_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_physical_envelope_{length_scale:.3f}.xml"
            )
            physical_envelope_model = _add_physical_visual_envelope_capsules(
                source_mjcf=physical_visual_output_mjcf,
                output_mjcf=physical_envelope_output_mjcf,
            )
            scaled_physical_envelope_model = {
                **physical_envelope_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "residual_fit_geom_count": fit_model["fit_geom_count"],
                "physical_visual_remediation_geom_count": physical_visual_model[
                    "remediation_geom_count"
                ],
                "scaled_geom_count": (
                    int(structural_model["scaled_geom_count"])
                    + int(fit_model["scaled_geom_count"])
                    + int(physical_visual_model["scaled_geom_count"])
                    + int(physical_envelope_model["scaled_geom_count"])
                ),
                "fit_geom_count": (
                    int(fit_model["fit_geom_count"])
                    + int(physical_visual_model["fit_geom_count"])
                    + int(physical_envelope_model["fit_geom_count"])
                ),
                "physical_envelope_geom_count": physical_envelope_model[
                    "physical_envelope_geom_count"
                ],
                "scaled_geoms": [
                    *structural_model["scaled_geoms"],
                    *fit_model["scaled_geoms"],
                    *physical_visual_model["scaled_geoms"],
                    *physical_envelope_model["scaled_geoms"],
                ],
            }
            physical_envelope_record = _sweep_record(
                mjcf_path=physical_envelope_output_mjcf,
                scale=None,
                length_scale=float(length_scale),
                target_links=reconstruction_target_links,
                strategy="physical_visual_envelope",
                body_groups=body_groups,
                scaled_model=scaled_physical_envelope_model,
                structural_report=structural,
            )
            physical_envelope_record["production_accepted"] = False
            physical_envelope_record["acceptance_blocker"] = (
                "visual-envelope capsules are real self-colliders and pass the sampled "
                "visual-fit gate, but they introduce unapproved knee, foot, and cross-leg "
                "contacts; the next collider family must preserve the envelope while "
                "splitting or trimming those contact regions"
            )
            physical_envelope_records.append(physical_envelope_record)

            physical_envelope_exclusion_output_mjcf = tmp_path / (
                f"asimov_fembot_collision_physical_envelope_exclusions_{length_scale:.3f}.xml"
            )
            exclusion_model = _add_contact_exclusions(
                source_mjcf=physical_envelope_output_mjcf,
                output_mjcf=physical_envelope_exclusion_output_mjcf,
                body_pairs=SAME_LIMB_DISTAL_CONTACT_EXCLUSIONS,
            )
            scaled_physical_envelope_exclusion_model = {
                **physical_envelope_model,
                **exclusion_model,
                "length_scale": float(length_scale),
                "target_links": sorted(reconstruction_target_links),
                "structural_scaled_geom_count": structural_model["scaled_geom_count"],
                "residual_fit_geom_count": fit_model["fit_geom_count"],
                "physical_visual_remediation_geom_count": physical_visual_model[
                    "remediation_geom_count"
                ],
                "scaled_geom_count": scaled_physical_envelope_model["scaled_geom_count"],
                "fit_geom_count": scaled_physical_envelope_model["fit_geom_count"],
                "physical_envelope_geom_count": physical_envelope_model[
                    "physical_envelope_geom_count"
                ],
                "contact_exclusion_count": exclusion_model["contact_exclusion_count"],
                "scaled_geoms": scaled_physical_envelope_model["scaled_geoms"],
            }
            physical_envelope_exclusion_record = _sweep_record(
                mjcf_path=physical_envelope_exclusion_output_mjcf,
                scale=None,
                length_scale=float(length_scale),
                target_links=reconstruction_target_links,
                strategy="physical_visual_envelope_same_limb_exclusions",
                body_groups=body_groups,
                scaled_model=scaled_physical_envelope_exclusion_model,
                structural_report=structural,
            )
            physical_envelope_exclusion_record["production_accepted"] = False
            physical_envelope_exclusion_record["acceptance_blocker"] = (
                "same-limb knee-to-ankle-roll contact exclusions remove internal "
                "knee-envelope versus foot contacts, but sampled cross-leg knee and "
                "hip-yaw contacts remain; those require geometric trimming, hip-spacing "
                "limits, or pose/controller constraints rather than contact-policy masking"
            )
            physical_envelope_exclusion_records.append(physical_envelope_exclusion_record)

            for inward_limit in hip_roll_inward_limit_candidates:
                hip_roll_output_mjcf = tmp_path / (
                    "asimov_fembot_collision_physical_envelope_"
                    f"hip_roll_{inward_limit:.3f}.xml"
                )
                hip_roll_model = _limit_inward_hip_roll(
                    source_mjcf=physical_envelope_exclusion_output_mjcf,
                    output_mjcf=hip_roll_output_mjcf,
                    inward_limit_rad=float(inward_limit),
                )
                scaled_hip_roll_model = {
                    **scaled_physical_envelope_exclusion_model,
                    **hip_roll_model,
                }
                hip_roll_record = _sweep_record(
                    mjcf_path=hip_roll_output_mjcf,
                    scale=None,
                    length_scale=float(length_scale),
                    target_links=reconstruction_target_links,
                    strategy="physical_visual_envelope_hip_roll_limit",
                    body_groups=body_groups,
                    scaled_model=scaled_hip_roll_model,
                    structural_report=structural,
                )
                hip_roll_record["production_accepted"] = False
                hip_roll_record["acceptance_blocker"] = (
                    "tightening inward hip-roll limits can clear the sampled cross-leg "
                    "envelope contacts, but this is a controller/range constraint and not "
                    "a geometric collider reconstruction; production acceptance still "
                    "requires preserving useful motion while proving collider geometry, "
                    "foot handling, mass/inertia, and controller behavior"
                )
                hip_roll_limit_records.append(hip_roll_record)
        for segment_count, segment_length_scale in segment_candidates:
            output_mjcf = (
                tmp_path
                / f"asimov_fembot_collision_segment_{segment_count}_{segment_length_scale:.3f}.xml"
            )
            scaled_model = _segment_body_capsules(
                source_mjcf=source_mjcf,
                output_mjcf=output_mjcf,
                segment_count=int(segment_count),
                segment_length_scale=float(segment_length_scale),
            )
            segment_records.append(
                _sweep_record(
                    mjcf_path=output_mjcf,
                    scale=None,
                    segment_count=int(segment_count),
                    segment_length_scale=float(segment_length_scale),
                    strategy="segmented_axis",
                    body_groups=body_groups,
                    scaled_model=scaled_model,
                    structural_report=structural,
                )
            )

    records = (
        radius_records
        + length_records
        + targeted_length_records
        + reconstruction_targeted_length_records
        + link_specific_fit_records
        + physical_visual_remediation_records
        + segment_records
    )
    accepted_records = [record for record in records if record.get("accepted")]
    accepted_radius_records = [record for record in radius_records if record.get("accepted")]
    accepted_length_records = [record for record in length_records if record.get("accepted")]
    accepted_targeted_length_records = [
        record for record in targeted_length_records if record.get("accepted")
    ]
    accepted_reconstruction_targeted_length_records = [
        record for record in reconstruction_targeted_length_records if record.get("accepted")
    ]
    accepted_link_specific_fit_records = [
        record for record in link_specific_fit_records if record.get("accepted")
    ]
    accepted_physical_visual_remediation_records = [
        record for record in physical_visual_remediation_records if record.get("accepted")
    ]
    visual_envelope_proxy_visual_fit_records = [
        record
        for record in visual_envelope_proxy_records
        if record.get("visual_fit", {}).get("accepted")
    ]
    visual_envelope_proxy_contact_clean_records = [
        record for record in visual_envelope_proxy_records if record.get("accepted")
    ]
    floor_contact_proxy_visual_fit_records = [
        record
        for record in floor_contact_proxy_records
        if record.get("visual_fit", {}).get("accepted")
    ]
    floor_contact_proxy_contact_clean_records = [
        record for record in floor_contact_proxy_records if record.get("accepted")
    ]
    physical_envelope_visual_fit_records = [
        record
        for record in physical_envelope_records
        if record.get("visual_fit", {}).get("accepted")
    ]
    physical_envelope_contact_clean_records = [
        record for record in physical_envelope_records if record.get("accepted")
    ]
    physical_envelope_exclusion_visual_fit_records = [
        record
        for record in physical_envelope_exclusion_records
        if record.get("visual_fit", {}).get("accepted")
    ]
    physical_envelope_exclusion_contact_clean_records = [
        record for record in physical_envelope_exclusion_records if record.get("accepted")
    ]
    hip_roll_limit_contact_clean_records = [
        record for record in hip_roll_limit_records if record.get("accepted")
    ]
    hip_roll_limit_visual_fit_records = [
        record
        for record in hip_roll_limit_records
        if record.get("visual_fit", {}).get("accepted")
    ]
    targeted_structural_risk_clean_records = [
        record
        for record in targeted_length_records
        if int(record["summary"]["structural_remediation_contact_risk_pairs"]) == 0
    ]
    accepted_segment_records = [record for record in segment_records if record.get("accepted")]
    best_by_contacts = min(
        records,
        key=lambda record: (
            int(record["summary"]["unapproved_contact_count"]),
            int(record["summary"]["unapproved_contact_samples"]),
            float(record["summary"]["visual_fit_worst_mean_outside_margin_m"] or float("inf")),
            str(record["strategy"]),
            float(
                record["scale"]
                if record["scale"] is not None
                else record["length_scale"]
                if record["length_scale"] is not None
                else record["segment_length_scale"]
            ),
        ),
        default=None,
    )
    baseline = next((record for record in radius_records if abs(float(record["scale"]) - 1.0) < 1e-9), None)
    best_contact_clean = min(
        accepted_records,
        key=lambda record: (
            float(record["summary"]["visual_fit_worst_mean_outside_margin_m"] or float("inf")),
            float(record["summary"]["visual_fit_worst_outside_fraction"] or float("inf")),
            str(record["strategy"]),
        ),
        default=None,
    )
    ok = bool(fembot_mjcf.get("ok") and records and all(record.get("ok") for record in records))
    contact_clean = bool(ok and accepted_records)
    visual_fit_records = [record for record in records if record.get("visual_fit", {}).get("accepted")]
    structural_risk_records = [
        record
        for record in records
        if int(record["summary"]["structural_remediation_contact_risk_pairs"]) > 0
    ]
    structural_clean_records = [
        record
        for record in records
        if int(record["summary"]["structural_remediation_contact_risk_pairs"]) == 0
    ]
    structural_clean_and_contact_clean_records = [
        record
        for record in structural_clean_records
        if record.get("accepted")
    ]
    collider_reconstruction_plan = _collider_reconstruction_plan(
        targeted_length_records=targeted_length_records
    )
    visual_fit_remediation_plan = _visual_fit_remediation_plan(
        source_records=(
            physical_visual_remediation_records
            or link_specific_fit_records
            or accepted_records
        )
    )
    best_structural_clean = min(
        structural_clean_and_contact_clean_records,
        key=lambda record: (
            float(record["summary"]["visual_fit_worst_mean_outside_margin_m"] or float("inf")),
            float(record["summary"]["visual_fit_worst_outside_fraction"] or float("inf")),
            str(record["strategy"]),
        ),
        default=None,
    )
    return {
        "schema": FEMBOT_CONTACT_TUNING_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "fembot_mjcf": str(source_mjcf),
            "scale_candidates": [float(value) for value in scale_candidates],
            "length_scale_candidates": [float(value) for value in length_scale_candidates],
            "structural_target_length_scale_candidates": [
                float(value) for value in structural_target_length_scale_candidates
            ],
            "reconstruction_target_length_scale_candidates": [
                float(value) for value in reconstruction_target_length_scale_candidates
            ],
            "link_specific_fit_base_length_scale_candidates": [
                float(value) for value in link_specific_fit_base_length_scale_candidates
            ],
            "segment_candidates": [
                {"segment_count": int(count), "segment_length_scale": float(scale)}
                for count, scale in segment_candidates
            ],
            "structural_target_links": sorted(structural_target_links),
            "reconstruction_target_links": sorted(reconstruction_target_links),
            "model": (
                "body capsule radius, centerline-length, structural-targeted "
                "centerline-length, and segmented-axis sweeps; foot/toe "
                "floor-contact capsules are not scaled"
            ),
        },
        "summary": {
            "scales_tested": len(radius_records),
            "length_scales_tested": len(length_records),
            "structural_target_length_scales_tested": len(targeted_length_records),
            "reconstruction_target_length_scales_tested": len(
                reconstruction_targeted_length_records
            ),
            "segment_candidates_tested": len(segment_records),
            "link_specific_fit_candidates_tested": len(link_specific_fit_records),
            "physical_visual_remediation_candidates_tested": len(
                physical_visual_remediation_records
            ),
            "strategies_tested": 10,
            "contact_clean_scale_count": len(accepted_records),
            "radius_contact_clean_scale_count": len(accepted_radius_records),
            "length_contact_clean_scale_count": len(accepted_length_records),
            "structural_target_length_contact_clean_scale_count": len(
                accepted_targeted_length_records
            ),
            "reconstruction_target_length_contact_clean_scale_count": len(
                accepted_reconstruction_targeted_length_records
            ),
            "link_specific_fit_contact_clean_count": len(accepted_link_specific_fit_records),
            "physical_visual_remediation_contact_clean_count": len(
                accepted_physical_visual_remediation_records
            ),
            "physical_visual_remediation_visual_fit_clean_count": sum(
                1
                for record in physical_visual_remediation_records
                if record.get("visual_fit", {}).get("accepted")
            ),
            "physical_visual_remediation_geom_count": (
                physical_visual_remediation_records[0]["scaled_model"][
                    "remediation_geom_count"
                ]
                if physical_visual_remediation_records
                else 0
            ),
            "physical_visual_remediation_best_worst_mean_outside_margin_m": (
                min(
                    float(record["summary"]["visual_fit_worst_mean_outside_margin_m"])
                    for record in physical_visual_remediation_records
                )
                if physical_visual_remediation_records
                else None
            ),
            "physical_visual_remediation_best_worst_outside_fraction": (
                min(
                    float(record["summary"]["visual_fit_worst_outside_fraction"])
                    for record in physical_visual_remediation_records
                )
                if physical_visual_remediation_records
                else None
            ),
            "visual_envelope_proxy_candidates_tested": len(visual_envelope_proxy_records),
            "visual_envelope_proxy_contact_clean_count": len(
                visual_envelope_proxy_contact_clean_records
            ),
            "visual_envelope_proxy_visual_fit_clean_count": len(
                visual_envelope_proxy_visual_fit_records
            ),
            "visual_envelope_proxy_contact_enabled": False,
            "visual_envelope_proxy_floor_contact_enabled": False,
            "visual_envelope_proxy_self_contact_enabled": False,
            "visual_envelope_proxy_geom_count": (
                visual_envelope_proxy_records[0]["scaled_model"]["proxy_geom_count"]
                if visual_envelope_proxy_records
                else 0
            ),
            "visual_envelope_proxy_best_worst_mean_outside_margin_m": (
                min(
                    float(record["summary"]["visual_fit_worst_mean_outside_margin_m"])
                    for record in visual_envelope_proxy_records
                )
                if visual_envelope_proxy_records
                else None
            ),
            "visual_envelope_proxy_best_worst_outside_fraction": (
                min(
                    float(record["summary"]["visual_fit_worst_outside_fraction"])
                    for record in visual_envelope_proxy_records
                )
                if visual_envelope_proxy_records
                else None
            ),
            "floor_contact_proxy_candidates_tested": len(floor_contact_proxy_records),
            "floor_contact_proxy_contact_clean_count": len(
                floor_contact_proxy_contact_clean_records
            ),
            "floor_contact_proxy_visual_fit_clean_count": len(
                floor_contact_proxy_visual_fit_records
            ),
            "floor_contact_proxy_contact_enabled": True,
            "floor_contact_proxy_floor_contact_enabled": True,
            "floor_contact_proxy_self_contact_enabled": False,
            "floor_contact_proxy_geom_count": (
                floor_contact_proxy_records[0]["scaled_model"]["proxy_geom_count"]
                if floor_contact_proxy_records
                else 0
            ),
            "floor_contact_proxy_best_worst_mean_outside_margin_m": (
                min(
                    float(record["summary"]["visual_fit_worst_mean_outside_margin_m"])
                    for record in floor_contact_proxy_records
                )
                if floor_contact_proxy_records
                else None
            ),
            "floor_contact_proxy_best_worst_outside_fraction": (
                min(
                    float(record["summary"]["visual_fit_worst_outside_fraction"])
                    for record in floor_contact_proxy_records
                )
                if floor_contact_proxy_records
                else None
            ),
            "physical_envelope_candidates_tested": len(physical_envelope_records),
            "physical_envelope_contact_clean_count": len(physical_envelope_contact_clean_records),
            "physical_envelope_visual_fit_clean_count": len(
                physical_envelope_visual_fit_records
            ),
            "physical_envelope_contact_enabled": True,
            "physical_envelope_floor_contact_enabled": True,
            "physical_envelope_self_contact_enabled": True,
            "physical_envelope_geom_count": (
                physical_envelope_records[0]["scaled_model"]["physical_envelope_geom_count"]
                if physical_envelope_records
                else 0
            ),
            "physical_envelope_best_unapproved_contact_count": (
                min(
                    int(record["summary"]["unapproved_contact_count"])
                    for record in physical_envelope_records
                )
                if physical_envelope_records
                else None
            ),
            "physical_envelope_best_contact_pair_count": (
                min(
                    int(record["summary"]["contact_pair_count"])
                    for record in physical_envelope_records
                )
                if physical_envelope_records
                else None
            ),
            "physical_envelope_best_worst_mean_outside_margin_m": (
                min(
                    float(record["summary"]["visual_fit_worst_mean_outside_margin_m"])
                    for record in physical_envelope_records
                )
                if physical_envelope_records
                else None
            ),
            "physical_envelope_best_worst_outside_fraction": (
                min(
                    float(record["summary"]["visual_fit_worst_outside_fraction"])
                    for record in physical_envelope_records
                )
                if physical_envelope_records
                else None
            ),
            "physical_envelope_exclusion_candidates_tested": len(
                physical_envelope_exclusion_records
            ),
            "physical_envelope_exclusion_contact_clean_count": len(
                physical_envelope_exclusion_contact_clean_records
            ),
            "physical_envelope_exclusion_visual_fit_clean_count": len(
                physical_envelope_exclusion_visual_fit_records
            ),
            "physical_envelope_exclusion_contact_exclusion_count": (
                physical_envelope_exclusion_records[0]["scaled_model"][
                    "contact_exclusion_count"
                ]
                if physical_envelope_exclusion_records
                else 0
            ),
            "physical_envelope_exclusion_best_unapproved_contact_count": (
                min(
                    int(record["summary"]["unapproved_contact_count"])
                    for record in physical_envelope_exclusion_records
                )
                if physical_envelope_exclusion_records
                else None
            ),
            "physical_envelope_exclusion_best_contact_pair_count": (
                min(
                    int(record["summary"]["contact_pair_count"])
                    for record in physical_envelope_exclusion_records
                )
                if physical_envelope_exclusion_records
                else None
            ),
            "physical_envelope_exclusion_best_worst_mean_outside_margin_m": (
                min(
                    float(record["summary"]["visual_fit_worst_mean_outside_margin_m"])
                    for record in physical_envelope_exclusion_records
                )
                if physical_envelope_exclusion_records
                else None
            ),
            "physical_envelope_exclusion_best_worst_outside_fraction": (
                min(
                    float(record["summary"]["visual_fit_worst_outside_fraction"])
                    for record in physical_envelope_exclusion_records
                )
                if physical_envelope_exclusion_records
                else None
            ),
            "hip_roll_limit_candidates_tested": len(hip_roll_limit_records),
            "hip_roll_limit_contact_clean_count": len(hip_roll_limit_contact_clean_records),
            "hip_roll_limit_visual_fit_clean_count": len(hip_roll_limit_visual_fit_records),
            "first_hip_roll_limit_contact_clean_rad": (
                hip_roll_limit_contact_clean_records[0]["scaled_model"][
                    "hip_roll_inward_limit_rad"
                ]
                if hip_roll_limit_contact_clean_records
                else None
            ),
            "hip_roll_limit_best_unapproved_contact_count": (
                min(
                    int(record["summary"]["unapproved_contact_count"])
                    for record in hip_roll_limit_records
                )
                if hip_roll_limit_records
                else None
            ),
            "hip_roll_limit_best_contact_pair_count": (
                min(
                    int(record["summary"]["contact_pair_count"])
                    for record in hip_roll_limit_records
                )
                if hip_roll_limit_records
                else None
            ),
            "first_link_specific_fit_contact_clean_length_scale": (
                accepted_link_specific_fit_records[0]["length_scale"]
                if accepted_link_specific_fit_records
                else None
            ),
            "structural_target_length_structural_risk_clean_scale_count": len(
                targeted_structural_risk_clean_records
            ),
            "segmented_contact_clean_scale_count": len(accepted_segment_records),
            "first_contact_clean_scale": (
                accepted_radius_records[0]["scale"] if accepted_radius_records else None
            ),
            "first_contact_clean_length_scale": (
                accepted_length_records[0]["length_scale"] if accepted_length_records else None
            ),
            "first_structural_target_length_contact_clean_scale": (
                accepted_targeted_length_records[0]["length_scale"]
                if accepted_targeted_length_records
                else None
            ),
            "first_reconstruction_target_length_contact_clean_scale": (
                accepted_reconstruction_targeted_length_records[0]["length_scale"]
                if accepted_reconstruction_targeted_length_records
                else None
            ),
            "first_structural_target_length_structural_risk_clean_scale": (
                targeted_structural_risk_clean_records[0]["length_scale"]
                if targeted_structural_risk_clean_records
                else None
            ),
            "first_contact_clean_segment": (
                {
                    "segment_count": accepted_segment_records[0]["segment_count"],
                    "segment_length_scale": accepted_segment_records[0]["segment_length_scale"],
                }
                if accepted_segment_records
                else None
            ),
            "baseline_unapproved_contact_count": (
                baseline["summary"]["unapproved_contact_count"] if baseline else None
            ),
            "baseline_unapproved_contact_samples": (
                baseline["summary"]["unapproved_contact_samples"] if baseline else None
            ),
            "baseline_structural_remediation_contact_risk_pairs": (
                baseline["summary"]["structural_remediation_contact_risk_pairs"]
                if baseline
                else None
            ),
            "baseline_structural_remediation_contact_risk_links": (
                baseline["summary"]["structural_remediation_contact_risk_links"]
                if baseline
                else None
            ),
            "best_scale": best_by_contacts["scale"] if best_by_contacts else None,
            "best_length_scale": best_by_contacts["length_scale"] if best_by_contacts else None,
            "best_segment_count": best_by_contacts["segment_count"] if best_by_contacts else None,
            "best_segment_length_scale": (
                best_by_contacts["segment_length_scale"] if best_by_contacts else None
            ),
            "best_strategy": best_by_contacts["strategy"] if best_by_contacts else None,
            "best_unapproved_contact_count": (
                best_by_contacts["summary"]["unapproved_contact_count"]
                if best_by_contacts
                else None
            ),
            "best_unapproved_contact_samples": (
                best_by_contacts["summary"]["unapproved_contact_samples"]
                if best_by_contacts
                else None
            ),
            "contact_clean_candidate_found": contact_clean,
            "link_specific_collider_reconstruction_pairs": len(collider_reconstruction_plan),
            "link_specific_collider_reconstruction_links": len(
                {
                    link
                    for record in collider_reconstruction_plan
                    for link in record.get("links", [])
                }
            ),
            "link_specific_collider_reconstruction_structural_pairs": sum(
                1
                for record in collider_reconstruction_plan
                if record["involves_structural_remediation_link"]
            ),
            "link_specific_fit_best_unapproved_contact_count": (
                min(
                    (
                        int(record["summary"]["unapproved_contact_count"])
                        for record in link_specific_fit_records
                    ),
                    default=None,
                )
            ),
            "link_specific_fit_best_contact_pair_count": (
                min(
                    (int(record["summary"]["contact_pair_count"]) for record in link_specific_fit_records),
                    default=None,
                )
            ),
            "visual_fit_remediation_geom_count": len(visual_fit_remediation_plan),
            "visual_fit_remediation_link_count": len(
                {
                    record["link"]
                    for record in visual_fit_remediation_plan
                    if record.get("link")
                }
            ),
            "visual_fit_remediation_worst_link": (
                visual_fit_remediation_plan[0]["link"]
                if visual_fit_remediation_plan
                else None
            ),
            "visual_fit_remediation_worst_geom": (
                visual_fit_remediation_plan[0]["geom"]
                if visual_fit_remediation_plan
                else None
            ),
            "structural_remediation_contact_risk_scale_count": len(structural_risk_records),
            "structural_remediation_contact_clean_scale_count": len(structural_clean_records),
            "structural_remediation_contact_clean_and_contact_clean_count": len(
                structural_clean_and_contact_clean_records
            ),
            "best_structural_remediation_contact_clean_strategy": (
                best_structural_clean["strategy"] if best_structural_clean else None
            ),
            "best_structural_remediation_contact_clean_scale": (
                best_structural_clean["scale"] if best_structural_clean else None
            ),
            "best_structural_remediation_contact_clean_length_scale": (
                best_structural_clean["length_scale"] if best_structural_clean else None
            ),
            "best_structural_remediation_contact_clean_visual_fit_worst_mean_outside_margin_m": (
                best_structural_clean["summary"]["visual_fit_worst_mean_outside_margin_m"]
                if best_structural_clean
                else None
            ),
            "best_contact_clean_strategy": (
                best_contact_clean["strategy"] if best_contact_clean else None
            ),
            "best_contact_clean_scale": (
                best_contact_clean["scale"] if best_contact_clean else None
            ),
            "best_contact_clean_length_scale": (
                best_contact_clean["length_scale"] if best_contact_clean else None
            ),
            "best_contact_clean_segment_count": (
                best_contact_clean["segment_count"] if best_contact_clean else None
            ),
            "best_contact_clean_segment_length_scale": (
                best_contact_clean["segment_length_scale"] if best_contact_clean else None
            ),
            "best_contact_clean_visual_fit_worst_mean_outside_margin_m": (
                best_contact_clean["summary"]["visual_fit_worst_mean_outside_margin_m"]
                if best_contact_clean
                else None
            ),
            "best_contact_clean_visual_fit_worst_outside_fraction": (
                best_contact_clean["summary"]["visual_fit_worst_outside_fraction"]
                if best_contact_clean
                else None
            ),
            "visual_fit_scale_count": len(visual_fit_records),
            "contact_clean_and_visual_fit_scale_count": sum(
                1
                for record in records
                if record.get("accepted") and record.get("visual_fit", {}).get("accepted")
            ),
            "accepted": False,
            "acceptance_blocker": (
                "a body-capsule scale clears sampled contacts, but no scale is production-accepted "
                "until collider-vs-visual fit, foot handling, mass/inertia coupling, and controller "
                "validation all pass"
                if contact_clean
                else "body-capsule scaling sweep has not produced a contact-clean generated fembot MJCF"
            ),
        },
        "scale_sweeps": radius_records,
        "length_scale_sweeps": length_records,
        "structural_target_length_scale_sweeps": targeted_length_records,
        "reconstruction_target_length_scale_sweeps": reconstruction_targeted_length_records,
        "link_specific_residual_fit_sweeps": link_specific_fit_records,
        "physical_visual_remediation_sweeps": physical_visual_remediation_records,
        "visual_envelope_proxy_sweeps": visual_envelope_proxy_records,
        "visual_envelope_floor_contact_proxy_sweeps": floor_contact_proxy_records,
        "physical_visual_envelope_sweeps": physical_envelope_records,
        "physical_visual_envelope_exclusion_sweeps": physical_envelope_exclusion_records,
        "physical_visual_envelope_hip_roll_limit_sweeps": hip_roll_limit_records,
        "segment_sweeps": segment_records,
        "link_specific_collider_reconstruction_plan": collider_reconstruction_plan,
        "visual_fit_remediation_plan": visual_fit_remediation_plan,
    }


def dump_fembot_contact_tuning_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_contact_tuning_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-contact-tuning.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_contact_tuning_proof_json(report), encoding="utf-8")
    return output
