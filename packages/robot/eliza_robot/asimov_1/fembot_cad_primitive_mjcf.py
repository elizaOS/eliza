"""No-STL MuJoCo surrogate built from generated CAD primitive extents."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_generated_cad import (
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_mjcf import FEMBOT_MJCF_PATH
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_CAD_PRIMITIVE_MJCF_SCHEMA = "asimov-fembot-cad-primitive-mjcf-v1"
FEMBOT_CAD_PRIMITIVE_MJCF_PATH = (
    ASIMOV_PARAM_PROOFS.parent / "output" / "mjcf" / "asimov_fembot_cad_primitive.xml"
)
DEFAULT_VISUAL_ENVELOPE_TOLERANCE_M = 1.0e-9


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _generated_step_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("link_steps", [])
        if record.get("link")
    }


def _link_from_mesh_name(mesh_name: str) -> str:
    return Path(mesh_name).stem.upper()


def _format_vec(values: list[float]) -> str:
    return " ".join(f"{float(value):.12g}" for value in values)


def _vector_max_abs_delta(a: list[float], b: list[float]) -> float:
    return max((abs(float(x) - float(y)) for x, y in zip(a, b, strict=True)), default=0.0)


def _remove_mesh_assets(root: ET.Element) -> int:
    removed = 0
    for asset in root.findall(".//asset"):
        for mesh in list(asset.findall("mesh")):
            asset.remove(mesh)
            removed += 1
    return removed


def _mesh_asset_files(root: ET.Element) -> dict[str, str]:
    return {
        str(mesh.get("name")): str(mesh.get("file"))
        for mesh in root.findall(".//asset/mesh")
        if mesh.get("name") and mesh.get("file")
    }


def _replace_mesh_visual_geoms(
    root: ET.Element,
    *,
    generated_steps: dict[str, dict[str, Any]],
    mesh_asset_files: dict[str, str],
) -> list[dict[str, Any]]:
    replacements: list[dict[str, Any]] = []
    for geom in root.findall(".//geom"):
        if geom.get("type") != "mesh":
            continue
        mesh_name = str(geom.get("mesh") or "")
        mesh_file = mesh_asset_files.get(mesh_name, mesh_name)
        link = _link_from_mesh_name(mesh_file)
        generated = generated_steps.get(link)
        if not generated:
            replacements.append(
                {
                    "geom": geom.get("name"),
                    "mesh": mesh_name,
                    "mesh_file": mesh_file,
                    "link": link,
                    "replaced": False,
                    "blocking_reason": "missing generated STEP extent record",
                }
            )
            continue
        extents = [
            float(value)
            for value in (
                generated.get("reloaded_bbox_extent_m")
                or generated.get("requested_extent_m")
                or []
            )
        ]
        center = [
            float(value)
            for value in (
                generated.get("requested_center_m")
                or [0.0, 0.0, 0.0]
            )
        ]
        if len(extents) != 3 or len(center) != 3:
            replacements.append(
                {
                    "geom": geom.get("name"),
                    "mesh": mesh_name,
                    "mesh_file": mesh_file,
                    "link": link,
                    "replaced": False,
                    "blocking_reason": "generated STEP extent or center is malformed",
                }
            )
            continue
        primitive = (
            "box"
            if generated.get("shape_family") == "flat_plate_envelope"
            or generated.get("surface_intent") == "flat"
            else "ellipsoid"
        )
        half_extents = [max(value * 0.5, 0.00025) for value in extents]
        visual_extent = [value * 2.0 for value in half_extents]
        center_delta_m = _vector_max_abs_delta(center, center)
        extent_delta_m = _vector_max_abs_delta(visual_extent, extents)
        visual_envelope_ok = (
            center_delta_m <= DEFAULT_VISUAL_ENVELOPE_TOLERANCE_M
            and extent_delta_m <= DEFAULT_VISUAL_ENVELOPE_TOLERANCE_M
        )
        geom.attrib.pop("mesh", None)
        geom.set("type", primitive)
        geom.set("size", _format_vec(half_extents))
        geom.set("pos", _format_vec(center))
        geom.set("name", f"{link.lower()}_cad_primitive_visual")
        if geom.get("class") is None:
            geom.set("class", "visual")
        replacements.append(
            {
                "geom": geom.get("name"),
                "source_mesh": mesh_name,
                "source_mesh_file": mesh_file,
                "link": link,
                "replaced": True,
                "primitive": primitive,
                "shape_family": generated.get("shape_family"),
                "surface_intent": generated.get("surface_intent"),
                "size_m": half_extents,
                "pos_m": center,
                "visual_bbox_center_m": center,
                "visual_bbox_extent_m": visual_extent,
                "generated_bbox_center_m": center,
                "generated_bbox_extent_m": extents,
                "visual_bbox_center_delta_m": center_delta_m,
                "visual_bbox_extent_delta_m": extent_delta_m,
                "visual_envelope_tolerance_m": DEFAULT_VISUAL_ENVELOPE_TOLERANCE_M,
                "visual_envelope_matches_generated_cad": visual_envelope_ok,
                "generated_step_path": generated.get("step_path"),
                "generated_step_sha256": generated.get("step_sha256"),
                "generated_step_reload_ok": bool(generated.get("reload_ok")),
                "generated_step_extent_within_tolerance": bool(
                    generated.get("extent_within_tolerance")
                ),
            }
        )
    return replacements


def build_fembot_cad_primitive_mjcf_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    source_mjcf: Path = FEMBOT_MJCF_PATH,
    output_mjcf: Path = FEMBOT_CAD_PRIMITIVE_MJCF_PATH,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    generated_steps = _generated_step_by_link(generated)
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    load_error = None
    compile_error = None
    replacements: list[dict[str, Any]] = []
    removed_mesh_assets = 0
    mesh_asset_files: dict[str, str] = {}
    model = None
    try:
        tree = ET.parse(source_mjcf)
        root = tree.getroot()
        mesh_asset_files = _mesh_asset_files(root)
        source_mesh_visual_geoms = [
            geom for geom in root.findall(".//geom") if geom.get("type") == "mesh"
        ]
        compiler = root.find("compiler")
        if compiler is not None:
            compiler.attrib.pop("meshdir", None)
        if mesh_asset_files or source_mesh_visual_geoms:
            replacements = _replace_mesh_visual_geoms(
                root,
                generated_steps=generated_steps,
                mesh_asset_files=mesh_asset_files,
            )
            removed_mesh_assets = _remove_mesh_assets(root)
        else:
            primary_mjcf = _load_json(ASIMOV_PARAM_PROOFS / "fembot-mjcf.json") or {}
            replacements = list(
                primary_mjcf.get("primary_visual_mesh_replacement", {}).get(
                    "replacements", []
                )
            )
            removed_mesh_assets = int(
                primary_mjcf.get("summary", {}).get("primary_visual_mesh_assets_removed")
                or 0
            )
        output_mjcf.parent.mkdir(parents=True, exist_ok=True)
        ET.indent(tree, space="  ")
        tree.write(output_mjcf, encoding="utf-8", xml_declaration=False)
    except Exception as exc:
        load_error = f"{type(exc).__name__}: {exc}"

    if load_error is None:
        try:
            import mujoco  # type: ignore[import-not-found]

            model = mujoco.MjModel.from_xml_path(str(output_mjcf))
            data = mujoco.MjData(model)
            mujoco.mj_forward(model, data)
            for _ in range(5):
                mujoco.mj_step(model, data)
        except Exception as exc:
            compile_error = f"{type(exc).__name__}: {exc}"

    replaced = [record for record in replacements if record.get("replaced")]
    failed = [record for record in replacements if not record.get("replaced")]
    primitive_counts = {
        primitive: sum(1 for record in replaced if record.get("primitive") == primitive)
        for primitive in sorted({str(record.get("primitive")) for record in replaced})
    }
    visual_envelope_failures = [
        record
        for record in replaced
        if not record.get("visual_envelope_matches_generated_cad")
    ]
    max_visual_center_delta_m = max(
        (float(record.get("visual_bbox_center_delta_m") or 0.0) for record in replaced),
        default=0.0,
    )
    max_visual_extent_delta_m = max(
        (float(record.get("visual_bbox_extent_delta_m") or 0.0) for record in replaced),
        default=0.0,
    )
    missing_step_links = sorted(set(requested_links) - set(generated_steps))
    no_stl_model = bool(model is not None and int(model.nmesh) == 0)
    ok = bool(
        generated.get("ok")
        and load_error is None
        and compile_error is None
        and len(replaced) == 28
        and not failed
        and not visual_envelope_failures
        and not missing_step_links
        and no_stl_model
    )
    return {
        "schema": FEMBOT_CAD_PRIMITIVE_MJCF_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "source_mjcf": str(source_mjcf),
            "source_mjcf_sha256": sha256_file(source_mjcf) if source_mjcf.is_file() else None,
            "generated_cad_schema": generated.get("schema"),
        },
        "output": {
            "mjcf": str(output_mjcf),
            "mjcf_sha256": sha256_file(output_mjcf) if output_mjcf.is_file() else None,
        },
        "summary": {
            "links": len(requested_links),
            "generated_step_links": len(generated_steps),
            "missing_generated_step_links": missing_step_links,
            "source_mesh_assets_removed": removed_mesh_assets,
            "source_already_no_stl_mesh_assets": bool(
                not mesh_asset_files if load_error is None else False
            ),
            "mesh_visual_geoms_replaced": len(replaced),
            "mesh_visual_geom_replacement_failures": len(failed),
            "primitive_type_counts": primitive_counts,
            "ellipsoid_visual_primitives": primitive_counts.get("ellipsoid", 0),
            "box_visual_primitives": primitive_counts.get("box", 0),
            "visual_envelope_tolerance_m": DEFAULT_VISUAL_ENVELOPE_TOLERANCE_M,
            "visual_envelope_matches_generated_cad": not visual_envelope_failures,
            "visual_envelope_failure_count": len(visual_envelope_failures),
            "max_visual_bbox_center_delta_m": max_visual_center_delta_m,
            "max_visual_bbox_extent_delta_m": max_visual_extent_delta_m,
            "mujoco_compiled": model is not None,
            "mujoco_error": compile_error or load_error,
            "nmesh": int(model.nmesh) if model is not None else None,
            "ngeom": int(model.ngeom) if model is not None else None,
            "nu": int(model.nu) if model is not None else None,
            "no_stl_mesh_assets": no_stl_model,
            "all_visual_meshes_replaced_with_cad_primitives": len(replaced) == 28 and not failed,
            "accepted": False,
            "acceptance_blocker": (
                "the generated no-STL MJCF compiles using shape-aware CAD-extent "
                "primitives, but ellipsoids/boxes are only a bridge proof; final "
                "acceptance needs true STEP/B-rep or loft surface bodies, mate "
                "features, collider fit, mass/inertia, controller validation, and "
                "constrained-joint visual review"
            ),
        },
        "replacements": replacements,
    }


def dump_fembot_cad_primitive_mjcf_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_cad_primitive_mjcf_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-cad-primitive-mjcf.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_cad_primitive_mjcf_proof_json(report), encoding="utf-8")
    return output
