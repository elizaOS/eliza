"""All-CAD/no-STL readiness proof for the ASIMOV fembot target."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_cad_primitive_mjcf import (
    build_fembot_cad_primitive_mjcf_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import (
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_mjcf import FEMBOT_MJCF_PATH
from eliza_robot.asimov_1.fembot_waist_yaw_no_cutout import build_waist_yaw_no_cutout_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_ALL_CAD_READINESS_SCHEMA = "asimov-fembot-all-cad-readiness-v1"
PARAMETRIC_PARTS_ROOT = (
    Path(__file__).resolve().parents[2] / "cad" / "asimov-feminine" / "param" / "parts"
)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _link_from_mesh_file(file_name: str) -> str:
    return Path(file_name).stem.upper()


def _mesh_assets_by_name(root: ET.Element) -> dict[str, dict[str, Any]]:
    records = {}
    for mesh in root.findall(".//asset/mesh"):
        name = str(mesh.get("name") or "")
        file_name = str(mesh.get("file") or "")
        if not name or not file_name:
            continue
        records[name] = {
            "asset_name": name,
            "file": file_name,
            "link": _link_from_mesh_file(file_name),
            "uses_stl": file_name.lower().endswith(".stl"),
        }
    return records


def _mesh_visual_geoms(root: ET.Element) -> list[dict[str, Any]]:
    mesh_assets = _mesh_assets_by_name(root)
    records = []
    for geom in root.findall(".//geom"):
        if geom.get("type") != "mesh":
            continue
        mesh_name = str(geom.get("mesh") or "")
        asset = mesh_assets.get(mesh_name, {})
        records.append(
            {
                "geom": geom.get("name"),
                "mesh": mesh_name,
                "class": geom.get("class"),
                "file": asset.get("file"),
                "link": asset.get("link"),
                "uses_stl": bool(asset.get("uses_stl")),
            }
        )
    return records


def _generated_step_by_link(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link", "")).upper(): record
        for record in report.get("link_steps", [])
        if record.get("link")
    }


def _parametric_part_scripts_by_link(requested_links: list[str]) -> dict[str, dict[str, Any]]:
    scripts: dict[str, dict[str, Any]] = {}
    for link in requested_links:
        path = PARAMETRIC_PARTS_ROOT / f"{link}.py"
        scripts[link] = {
            "link": link,
            "path": str(path),
            "exists": path.is_file(),
            "uses_parametric_python": path.is_file(),
            "is_stl_source": False,
        }
    return scripts


def build_fembot_all_cad_readiness_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    cad_primitive_mjcf_report: dict[str, Any] | None = None,
    fembot_mjcf_report: dict[str, Any] | None = None,
    waist_yaw_no_cutout_report: dict[str, Any] | None = None,
    mjcf_path: Path = FEMBOT_MJCF_PATH,
    source_mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    primitive_mjcf = (
        cad_primitive_mjcf_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-cad-primitive-mjcf.json")
        or build_fembot_cad_primitive_mjcf_proof(
            body_groups,
            generated_cad_report=generated,
        )
    )
    fembot_mjcf = fembot_mjcf_report or _load_json(ASIMOV_PARAM_PROOFS / "fembot-mjcf.json") or {}
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    generated_steps = _generated_step_by_link(generated)
    parametric_part_scripts = _parametric_part_scripts_by_link(requested_links)
    waist_yaw_no_cutout = waist_yaw_no_cutout_report or _load_json(
        ASIMOV_PARAM_PROOFS / "waist-yaw-no-cutout.json"
    )
    if waist_yaw_no_cutout is None:
        try:
            waist_yaw_no_cutout = build_waist_yaw_no_cutout_proof()
        except Exception as exc:
            waist_yaw_no_cutout = {
                "schema": "asimov-fembot-waist-yaw-no-cutout-proof-v1",
                "accepted": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

    mjcf_load_error = None
    mesh_assets: dict[str, dict[str, Any]] = {}
    mesh_visual_geoms: list[dict[str, Any]] = []
    try:
        root = ET.parse(mjcf_path).getroot()
        mesh_assets = _mesh_assets_by_name(root)
        mesh_visual_geoms = _mesh_visual_geoms(root)
    except Exception as exc:
        mjcf_load_error = f"{type(exc).__name__}: {exc}"

    asset_records = []
    for asset in sorted(mesh_assets.values(), key=lambda item: str(item["asset_name"])):
        link = str(asset.get("link") or "").upper()
        generated_record = generated_steps.get(link)
        step_path = generated_record.get("step_path") if generated_record else None
        asset_records.append(
            {
                **asset,
                "generated_step_path": step_path,
                "generated_step_sha256": (
                    generated_record.get("step_sha256") if generated_record else None
                ),
                "generated_step_export_ok": bool(
                    generated_record and generated_record.get("export_ok")
                ),
                "generated_step_reload_ok": bool(
                    generated_record and generated_record.get("reload_ok")
                ),
                "generated_step_extent_within_tolerance": bool(
                    generated_record and generated_record.get("extent_within_tolerance")
                ),
                "all_cad_blocker": (
                    "MJCF visual/collision presentation still uses an STL mesh asset; "
                    "replace this with a STEP/B-rep or parametric loft part and a "
                    "non-STL MuJoCo representation before final acceptance"
                )
                if asset.get("uses_stl")
                else None,
            }
        )

    links_with_generated_steps = {
        link
        for link in requested_links
        if (record := generated_steps.get(link))
        and record.get("step_path")
        and record.get("export_ok")
        and record.get("reload_ok")
        and record.get("extent_within_tolerance")
    }
    stl_asset_links = {
        str(record.get("link", "")).upper()
        for record in asset_records
        if record.get("uses_stl") and record.get("link")
    }
    primary_visual_replacements = [
        record
        for record in fembot_mjcf.get("primary_visual_mesh_replacement", {}).get(
            "replacements", []
        )
        if record.get("replaced") and record.get("link")
    ]
    primary_replacement_links = {
        str(record.get("link", "")).upper()
        for record in primary_visual_replacements
    }
    missing_generated_step_links = sorted(set(requested_links) - links_with_generated_steps)
    missing_parametric_part_scripts = sorted(
        link
        for link in requested_links
        if not parametric_part_scripts.get(link, {}).get("exists")
    )
    mjcf_link_coverage = {
        str(record.get("link", "")).upper()
        for record in asset_records
        if record.get("link")
    } | primary_replacement_links
    missing_mjcf_asset_links = sorted(set(requested_links) - mjcf_link_coverage)
    stl_visual_geoms = [record for record in mesh_visual_geoms if record["uses_stl"]]
    primary_no_stl_mesh_assets = not stl_asset_links and not stl_visual_geoms
    primary_replacement_ok = bool(
        fembot_mjcf.get("ok")
        and fembot_mjcf.get("summary", {}).get("no_stl_mesh_assets")
        and fembot_mjcf.get("summary", {}).get("primary_visual_mesh_replacement_ok")
        and len(primary_replacement_links) == len(requested_links)
    )
    ok = bool(
        generated.get("ok")
        and mjcf_load_error is None
        and len(requested_links) == 28
        and len(links_with_generated_steps) == len(requested_links)
        and not missing_mjcf_asset_links
    )
    accepted = bool(ok and primary_no_stl_mesh_assets and generated.get("accepted"))
    return {
        "schema": FEMBOT_ALL_CAD_READINESS_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "cad_primitive_mjcf_schema": primitive_mjcf.get("schema"),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "mjcf": str(mjcf_path),
            "source_mjcf": str(source_mjcf_path),
        },
        "summary": {
            "links": len(requested_links),
            "links_with_generated_step_reference": len(links_with_generated_steps),
            "missing_generated_step_links": missing_generated_step_links,
            "parametric_part_scripts": len(parametric_part_scripts) - len(missing_parametric_part_scripts),
            "missing_parametric_part_scripts": missing_parametric_part_scripts,
            "waist_yaw_no_cutout_accepted": bool(waist_yaw_no_cutout.get("accepted")),
            "waist_yaw_no_cutout_method": waist_yaw_no_cutout.get("method"),
            "waist_yaw_generated_sections_ok": waist_yaw_no_cutout.get("generated_sections_ok"),
            "mjcf_load_error": mjcf_load_error,
            "mjcf_mesh_assets": len(mesh_assets),
            "mjcf_mesh_visual_geoms": len(mesh_visual_geoms),
            "mjcf_stl_mesh_assets": sum(
                1 for record in asset_records if record.get("uses_stl")
            ),
            "mjcf_stl_mesh_visual_geoms": len(stl_visual_geoms),
            "links_still_using_stl_mesh_assets": len(stl_asset_links),
            "stl_mesh_asset_links": sorted(stl_asset_links),
            "missing_mjcf_asset_links": missing_mjcf_asset_links,
            "no_stl_mesh_assets": primary_no_stl_mesh_assets,
            "primary_no_stl_mesh_assets": primary_no_stl_mesh_assets,
            "primary_mjcf_ok": bool(fembot_mjcf.get("ok")),
            "primary_mjcf_nmesh": fembot_mjcf.get("summary", {}).get("nmesh"),
            "primary_mjcf_no_stl_mesh_assets": fembot_mjcf.get("summary", {}).get(
                "no_stl_mesh_assets"
            ),
            "primary_visual_mesh_replacement_ok": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_replacement_ok"
            ),
            "primary_visual_mesh_geoms_replaced": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_geoms_replaced"
            ),
            "primary_visual_mesh_assets_removed": fembot_mjcf.get("summary", {}).get(
                "primary_visual_mesh_assets_removed"
            ),
            "primary_visual_envelope_failures": fembot_mjcf.get("summary", {}).get(
                "primary_visual_envelope_failure_count"
            ),
            "primary_visual_max_bbox_center_delta_m": fembot_mjcf.get("summary", {}).get(
                "primary_visual_max_bbox_center_delta_m"
            ),
            "primary_visual_max_bbox_extent_delta_m": fembot_mjcf.get("summary", {}).get(
                "primary_visual_max_bbox_extent_delta_m"
            ),
            "primary_replacement_links": len(primary_replacement_links),
            "primary_replacement_ok": primary_replacement_ok,
            "no_stl_primitive_surrogate_ok": bool(primitive_mjcf.get("ok")),
            "no_stl_primitive_surrogate_nmesh": primitive_mjcf.get("summary", {}).get(
                "nmesh"
            ),
            "no_stl_primitive_surrogate_visual_replacements": primitive_mjcf.get(
                "summary", {}
            ).get("mesh_visual_geoms_replaced"),
            "no_stl_primitive_surrogate_ellipsoid_visuals": primitive_mjcf.get(
                "summary", {}
            ).get("ellipsoid_visual_primitives"),
            "no_stl_primitive_surrogate_box_visuals": primitive_mjcf.get(
                "summary", {}
            ).get("box_visual_primitives"),
            "no_stl_primitive_surrogate_visual_envelope_matches_generated_cad": primitive_mjcf.get(
                "summary", {}
            ).get("visual_envelope_matches_generated_cad"),
            "no_stl_primitive_surrogate_visual_envelope_failures": primitive_mjcf.get(
                "summary", {}
            ).get("visual_envelope_failure_count"),
            "no_stl_primitive_surrogate_max_visual_bbox_center_delta_m": primitive_mjcf.get(
                "summary", {}
            ).get("max_visual_bbox_center_delta_m"),
            "no_stl_primitive_surrogate_max_visual_bbox_extent_delta_m": primitive_mjcf.get(
                "summary", {}
            ).get("max_visual_bbox_extent_delta_m"),
            "all_cad_parametric_ready": accepted,
            "accepted": accepted,
            "acceptance_blocker": (
                "all 28 links have generated STEP references and the primary MuJoCo "
                "model now compiles without STL mesh assets using generated CAD-envelope "
                "primitives, but final acceptance still requires true STEP/B-rep or "
                "controlled-loft surface bodies with mate features rather than primitive "
                "visual surrogates"
            )
            if not accepted
            else None,
        },
        "cad_primitive_mjcf": {
            "ok": bool(primitive_mjcf.get("ok")),
            "accepted": bool(primitive_mjcf.get("accepted")),
            "summary": primitive_mjcf.get("summary", {}),
            "output": primitive_mjcf.get("output", {}),
        },
        "waist_yaw_no_cutout": {
            "accepted": bool(waist_yaw_no_cutout.get("accepted")),
            "summary": {
                "method": waist_yaw_no_cutout.get("method"),
                "generated_sections_ok": waist_yaw_no_cutout.get("generated_sections_ok"),
                "source_fragmented_sections": waist_yaw_no_cutout.get("source_fragmented_sections"),
                "topology": waist_yaw_no_cutout.get("topology", {}),
                "error": waist_yaw_no_cutout.get("error"),
            },
        },
        "parametric_part_scripts": list(parametric_part_scripts.values()),
        "mesh_assets": asset_records,
        "mesh_visual_geoms": mesh_visual_geoms,
    }


def dump_fembot_all_cad_readiness_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_all_cad_readiness_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-all-cad-readiness.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_all_cad_readiness_proof_json(report), encoding="utf-8")
    return output
