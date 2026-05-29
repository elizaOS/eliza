"""Proof that the generated WAIST_YAW torso has no front M cutout."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.constants import ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_OUTPUT_STL, ASIMOV_PARAM_PROOFS

WAIST_YAW_NO_CUTOUT_SCHEMA = "asimov-fembot-waist-yaw-no-cutout-proof-v1"
WAIST_YAW_CHEST_SECTION_LEVELS_M = (0.18, 0.21, 0.24, 0.261, 0.285, 0.31, 0.34)
DEFAULT_CLOSURE_TOLERANCE_M = 1.0e-8


def _section_record(mesh: trimesh.Trimesh, z_m: float) -> dict[str, Any]:
    section = mesh.section(plane_origin=[0.0, 0.0, z_m], plane_normal=[0.0, 0.0, 1.0])
    if section is None:
        return {
            "z_m": z_m,
            "loop_count": 0,
            "front_loop_count": 0,
            "max_closure_gap_m": None,
            "bounds_m": None,
            "ok": False,
        }

    loops = [np.asarray(polyline, dtype=np.float64) for polyline in section.discrete if len(polyline) >= 3]
    closure_gaps = [
        float(np.linalg.norm(polyline[0] - polyline[-1]))
        for polyline in loops
    ]
    front_loop_count = sum(1 for polyline in loops if float(polyline[:, 0].max()) > 0.0)
    return {
        "z_m": z_m,
        "loop_count": len(loops),
        "front_loop_count": front_loop_count,
        "max_closure_gap_m": max(closure_gaps) if closure_gaps else None,
        "bounds_m": section.bounds.tolist(),
        "ok": len(loops) == 1 and front_loop_count == 1 and max(closure_gaps, default=1.0) <= DEFAULT_CLOSURE_TOLERANCE_M,
    }


def build_waist_yaw_no_cutout_proof(
    *,
    source_stl: Path = ASIMOV1_SOURCE_MESH_DIR / "WAIST_YAW.STL",
    generated_stl: Path = ASIMOV_PARAM_OUTPUT_STL / "WAIST_YAW.STL",
) -> dict[str, Any]:
    source_mesh = trimesh.load(source_stl)
    generated_mesh = trimesh.load(generated_stl)
    source_sections = [
        _section_record(source_mesh, z_m)
        for z_m in WAIST_YAW_CHEST_SECTION_LEVELS_M
    ]
    generated_sections = [
        _section_record(generated_mesh, z_m)
        for z_m in WAIST_YAW_CHEST_SECTION_LEVELS_M
    ]
    generated_components = generated_mesh.split(only_watertight=False)
    generated_section_ok = all(section["ok"] for section in generated_sections)
    source_fragmented_sections = sum(
        1 for section in source_sections if int(section["loop_count"]) > 1
    )
    topology_ok = (
        bool(generated_mesh.is_watertight)
        and len(generated_components) == 1
        and int(generated_mesh.euler_number) == 2
    )
    accepted = topology_ok and generated_section_ok and source_fragmented_sections > 0
    return {
        "schema": WAIST_YAW_NO_CUTOUT_SCHEMA,
        "link": "WAIST_YAW",
        "source_stl": str(source_stl),
        "source_stl_sha256": sha256_file(source_stl),
        "generated_stl": str(generated_stl),
        "generated_stl_sha256": sha256_file(generated_stl),
        "method": "convex_hull_cross_section_rings_to_parametric_loft",
        "cutout_policy": "front M cutout and internal fragments are intentionally excluded from the outer hull rings",
        "accepted": accepted,
        "topology": {
            "watertight": bool(generated_mesh.is_watertight),
            "component_count": len(generated_components),
            "euler_number": int(generated_mesh.euler_number),
            "vertex_count": int(len(generated_mesh.vertices)),
            "face_count": int(len(generated_mesh.faces)),
            "ok": topology_ok,
        },
        "section_levels_m": list(WAIST_YAW_CHEST_SECTION_LEVELS_M),
        "section_closure_tolerance_m": DEFAULT_CLOSURE_TOLERANCE_M,
        "source_fragmented_sections": source_fragmented_sections,
        "source_sections": source_sections,
        "generated_sections": generated_sections,
        "generated_sections_ok": generated_section_ok,
    }


def dump_waist_yaw_no_cutout_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_waist_yaw_no_cutout_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "waist-yaw-no-cutout.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_waist_yaw_no_cutout_proof_json(report), encoding="utf-8")
    return output
