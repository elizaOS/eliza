"""Measured morphology effects for generated ASIMOV-1 fembot meshes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.morphology_parameters import morphology_parameter_catalog
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_OUTPUT_STL, ASIMOV_PARAM_PROOFS
from eliza_robot.asimov_1.spline_fit_proof import (
    AXIS_IDX,
    load_connection_specs,
    read_binary_stl_vertices,
)


MORPHOLOGY_EFFECT_SCHEMA = "asimov-1-morphology-effect-proof-v1"


def _bbox_extent(vertices: np.ndarray) -> np.ndarray:
    return vertices.max(axis=0) - vertices.min(axis=0)


def _slab(vertices: np.ndarray, *, axis_idx: int, level: float, half_width_m: float) -> np.ndarray:
    return vertices[np.abs(vertices[:, axis_idx] - level) <= half_width_m]


def _section_metrics(
    source_vertices: np.ndarray,
    output_vertices: np.ndarray,
    *,
    axis_idx: int,
    level: float,
    half_width_m: float = 0.01,
) -> dict[str, Any]:
    source = _slab(source_vertices, axis_idx=axis_idx, level=level, half_width_m=half_width_m)
    output = _slab(output_vertices, axis_idx=axis_idx, level=level, half_width_m=half_width_m)
    if len(source) == 0 or len(output) == 0:
        return {
            "level_m": float(level),
            "source_points": int(len(source)),
            "output_points": int(len(output)),
            "available": False,
        }
    source_min = source.min(axis=0)
    source_max = source.max(axis=0)
    output_min = output.min(axis=0)
    output_max = output.max(axis=0)
    return {
        "level_m": float(level),
        "source_points": int(len(source)),
        "output_points": int(len(output)),
        "available": True,
        "x_min_delta_m": float(output_min[0] - source_min[0]),
        "x_max_delta_m": float(output_max[0] - source_max[0]),
        "x_center_delta_m": float(((output_min[0] + output_max[0]) - (source_min[0] + source_max[0])) * 0.5),
        "x_extent_ratio": float((output_max[0] - output_min[0]) / max(source_max[0] - source_min[0], 1.0e-12)),
        "y_extent_ratio": float((output_max[1] - output_min[1]) / max(source_max[1] - source_min[1], 1.0e-12)),
    }


def _link_shape_record(
    link: str,
    *,
    source_root: Path,
    output_root: Path,
    connection_specs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    source_stl = source_root / f"{link}.STL"
    output_stl = output_root / f"{link}.STL"
    if not source_stl.is_file() or not output_stl.is_file():
        return {
            "link": link,
            "source_stl": str(source_stl),
            "output_stl": str(output_stl),
            "available": False,
        }
    source = read_binary_stl_vertices(source_stl)
    output = read_binary_stl_vertices(output_stl)
    axis = str(connection_specs.get(link, {}).get("spine", "z"))
    axis_idx = AXIS_IDX[axis]
    plane_dims = [dim for dim in range(3) if dim != axis_idx]
    source_extent = _bbox_extent(source)
    output_extent = _bbox_extent(output)
    extent_ratio = output_extent / np.maximum(source_extent, 1.0e-12)
    lo = float(source[:, axis_idx].min())
    hi = float(source[:, axis_idx].max())
    section_levels = {
        "low": lo + (hi - lo) * 0.25,
        "mid": lo + (hi - lo) * 0.50,
        "high": lo + (hi - lo) * 0.75,
    }
    return {
        "link": link,
        "source_stl": str(source_stl),
        "output_stl": str(output_stl),
        "source_sha256": sha256_file(source_stl),
        "output_sha256": sha256_file(output_stl),
        "available": True,
        "spine": axis,
        "bbox_extent_ratio": [float(value) for value in extent_ratio],
        "non_spine_area_ratio": float(np.prod(extent_ratio[plane_dims])),
        "spine_extent_ratio": float(extent_ratio[axis_idx]),
        "sections": {
            name: _section_metrics(
                source,
                output,
                axis_idx=axis_idx,
                level=level,
            )
            for name, level in section_levels.items()
        },
    }


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    return float(np.median(np.asarray(values, dtype=np.float64)))


def _parameter_effect_record(
    parameter: dict[str, Any],
    link_records: dict[str, dict[str, Any]],
    *,
    fembot_mjcf_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = str(parameter["name"])
    links = [str(link).upper() for link in parameter["affected_links"]]
    records = [link_records[link] for link in links if link in link_records]
    available = [record for record in records if record.get("available")]
    area_ratios = [float(record["non_spine_area_ratio"]) for record in available]
    spine_deltas = [abs(float(record["spine_extent_ratio"]) - 1.0) for record in available]
    metrics: dict[str, Any] = {
        "affected_links": links,
        "available_link_count": len(available),
        "median_non_spine_area_ratio": _median(area_ratios),
        "max_spine_extent_delta": max(spine_deltas, default=None),
    }
    evidence_links = [record["link"] for record in available]
    if name == "global_shell_scale":
        slimmed_links = [
            record["link"]
            for record in available
            if float(record["non_spine_area_ratio"]) < 0.98
        ]
        metrics["slimmed_link_count"] = len(slimmed_links)
        metrics["slimmed_link_fraction"] = len(slimmed_links) / len(available) if available else 0.0
        metrics["slimmed_links"] = slimmed_links
        accepted = len(slimmed_links) >= 8
        criterion = "at least 8 affected links have non-spine bbox area ratio below 0.98"
    elif name == "arm_slim_taper":
        accepted = bool(metrics["median_non_spine_area_ratio"] is not None and metrics["median_non_spine_area_ratio"] < 0.94)
        criterion = "median arm-link non-spine bbox area ratio is below 0.94"
    elif name == "upper_thigh_hip_flare":
        accepted = bool(metrics["median_non_spine_area_ratio"] is not None and metrics["median_non_spine_area_ratio"] > 1.05)
        criterion = "median upper-thigh non-spine bbox area ratio is above 1.05"
    elif name == "torso_waist_cinch_depth":
        waist_section_area_ratios = []
        waist_sections = {
            "WAIST_YAW": "low",
            "IMU_ORIGIN": "high",
        }
        for link, section_name in waist_sections.items():
            section = link_records.get(link, {}).get("sections", {}).get(section_name, {})
            if section.get("available"):
                waist_section_area_ratios.append(
                    float(section["x_extent_ratio"]) * float(section["y_extent_ratio"])
                )
        metrics["waist_section_area_ratios"] = waist_section_area_ratios
        metrics["median_waist_section_area_ratio"] = _median(waist_section_area_ratios)
        accepted = bool(
            metrics["median_waist_section_area_ratio"] is not None
            and metrics["median_waist_section_area_ratio"] < 0.95
        )
        criterion = "WAIST_YAW low and IMU_ORIGIN high waist sections show at least 5% median area reduction"
    elif name == "hip_spacing_scale":
        y_ratios = [float(record["bbox_extent_ratio"][1]) for record in available]
        metrics["median_y_extent_ratio"] = _median(y_ratios)
        mjcf_summary = (fembot_mjcf_report or {}).get("summary", {})
        metrics["fembot_mjcf_ok"] = bool((fembot_mjcf_report or {}).get("ok"))
        metrics["source_hip_spacing_m"] = mjcf_summary.get("source_hip_spacing_m")
        metrics["output_hip_spacing_m"] = mjcf_summary.get("output_hip_spacing_m")
        metrics["hip_spacing_ratio"] = mjcf_summary.get("hip_spacing_ratio")
        accepted = bool(
            metrics["fembot_mjcf_ok"]
            and metrics["hip_spacing_ratio"] is not None
            and float(metrics["hip_spacing_ratio"]) < 0.98
        )
        criterion = "generated fembot MJCF reduces left/right hip-pitch body spacing below 0.98x and compiles in MuJoCo"
    elif name == "bust_front_gain":
        waist = link_records.get("WAIST_YAW", {})
        section = waist.get("sections", {}).get("high", {})
        metrics["bust_band_x_max_delta_m"] = section.get("x_max_delta_m")
        accepted = bool(section.get("available") and float(section["x_max_delta_m"]) > 0.01)
        criterion = "WAIST_YAW high torso/bust band pushes front +X outward by more than 10 mm"
        evidence_links = ["WAIST_YAW"] if waist else []
    elif name == "back_arch_shift_m":
        waist = link_records.get("WAIST_YAW", {})
        section = waist.get("sections", {}).get("mid", {})
        metrics["mid_torso_x_center_delta_m"] = section.get("x_center_delta_m")
        accepted = bool(section.get("available") and float(section["x_center_delta_m"]) < -0.008)
        criterion = "WAIST_YAW mid torso center shifts back -X by more than 8 mm"
        evidence_links = ["WAIST_YAW"] if waist else []
    elif name == "calf_back_bulge":
        deltas = [
            float(record["sections"]["mid"]["x_min_delta_m"])
            for record in available
            if record.get("sections", {}).get("mid", {}).get("available")
        ]
        metrics["median_mid_calf_x_min_delta_m"] = _median(deltas)
        accepted = bool(metrics["median_mid_calf_x_min_delta_m"] is not None and metrics["median_mid_calf_x_min_delta_m"] < -0.005)
        criterion = "mid-calf back -X envelope expands by more than 5 mm"
    else:
        accepted = False
        criterion = "no morphology effect criterion is implemented"
    return {
        "name": name,
        "group": parameter["group"],
        "criterion": criterion,
        "accepted": accepted,
        "blocking_reason": None if accepted else "generated output does not yet prove the cataloged morphology effect",
        "metrics": metrics,
        "evidence_links": evidence_links,
    }


def build_morphology_effect_proof(
    *,
    source_root: Path = ASIMOV1_SOURCE_MESH_DIR,
    output_root: Path = ASIMOV_PARAM_OUTPUT_STL,
) -> dict[str, Any]:
    catalog = morphology_parameter_catalog()
    connection_specs = load_connection_specs()
    fembot_mjcf_report = generate_fembot_mjcf()
    affected_links = sorted({link for parameter in catalog["parameters"] for link in parameter["affected_links"]})
    link_records = {
        link: _link_shape_record(
            link,
            source_root=source_root,
            output_root=output_root,
            connection_specs=connection_specs,
        )
        for link in affected_links
    }
    parameter_records = [
        _parameter_effect_record(
            parameter,
            link_records,
            fembot_mjcf_report=fembot_mjcf_report,
        )
        for parameter in catalog["parameters"]
    ]
    accepted = [record for record in parameter_records if record["accepted"]]
    ok = bool(len(parameter_records) == int(catalog["parameter_count"]) and all(record.get("available") for record in link_records.values()))
    all_accepted = ok and len(accepted) == len(parameter_records)
    return {
        "schema": MORPHOLOGY_EFFECT_SCHEMA,
        "ok": ok,
        "accepted": all_accepted,
        "source": {
            "source_root": str(source_root),
            "output_root": str(output_root),
            "catalog_schema": catalog["schema"],
            "fembot_mjcf_schema": fembot_mjcf_report.get("schema"),
            "fembot_mjcf": fembot_mjcf_report.get("output", {}).get("mjcf"),
        },
        "summary": {
            "parameters": len(parameter_records),
            "accepted_parameters": len(accepted),
            "blocked_parameters": len(parameter_records) - len(accepted),
            "affected_links": len(link_records),
            "accepted": all_accepted,
            "acceptance_blocker": None
            if all_accepted
            else "not every cataloged morphology control has a measured generated-mesh effect yet",
        },
        "parameters": parameter_records,
        "links": [link_records[link] for link in sorted(link_records)],
    }


def dump_morphology_effect_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_morphology_effect_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "morphology-effects.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_morphology_effect_proof_json(report), encoding="utf-8")
    return output
