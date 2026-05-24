"""All-CAD/no-STL readiness proof for the ASIMOV fembot target."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_generated_cad import (
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_mjcf import FEMBOT_MJCF_PATH
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_ALL_CAD_READINESS_SCHEMA = "asimov-fembot-all-cad-readiness-v1"


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


def build_fembot_all_cad_readiness_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    mjcf_path: Path = FEMBOT_MJCF_PATH,
    source_mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
) -> dict[str, Any]:
    generated = (
        generated_cad_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json")
        or build_fembot_generated_cad_envelope_proof(body_groups)
    )
    requested_links = sorted(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    generated_steps = _generated_step_by_link(generated)

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
    missing_generated_step_links = sorted(set(requested_links) - links_with_generated_steps)
    missing_mjcf_asset_links = sorted(set(requested_links) - {
        str(record.get("link", "")).upper()
        for record in asset_records
        if record.get("link")
    })
    stl_visual_geoms = [record for record in mesh_visual_geoms if record["uses_stl"]]
    ok = bool(
        generated.get("ok")
        and mjcf_load_error is None
        and len(requested_links) == 28
        and len(links_with_generated_steps) == len(requested_links)
    )
    accepted = bool(ok and not stl_asset_links and not stl_visual_geoms)
    return {
        "schema": FEMBOT_ALL_CAD_READINESS_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "mjcf": str(mjcf_path),
            "source_mjcf": str(source_mjcf_path),
        },
        "summary": {
            "links": len(requested_links),
            "links_with_generated_step_reference": len(links_with_generated_steps),
            "missing_generated_step_links": missing_generated_step_links,
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
            "no_stl_mesh_assets": not stl_asset_links and not stl_visual_geoms,
            "all_cad_parametric_ready": accepted,
            "accepted": accepted,
            "acceptance_blocker": (
                "all 28 links have generated STEP references, but the loadable MuJoCo "
                "model still uses STL mesh assets; final acceptance requires replacing "
                "visual/collision STL bodies with CAD-parametric STEP/B-rep or loft "
                "parts and a non-STL MuJoCo representation"
            )
            if not accepted
            else None,
        },
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
