"""Foot contact and flat-plate handling proof for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.collision_sweep import (
    APPROVED_FLOOR_PREFIXES,
    build_asimov1_collision_sweep_proof,
)
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof
from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.fembot_surface_quality import build_fembot_surface_quality_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_FOOT_HANDLING_SCHEMA = "asimov-fembot-foot-handling-proof-v1"
FOOT_LINKS = ("LEFT_TOE", "RIGHT_TOE")


def _geom_name(mujoco: Any, model: Any, geom_id: int) -> str:
    return mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id)) or str(geom_id)


def _compiled_foot_collision_geoms(mjcf_path: Path) -> dict[str, dict[str, Any]]:
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    records: dict[str, dict[str, Any]] = {}
    for geom_id in range(int(model.ngeom)):
        name = _geom_name(mujoco, model, geom_id)
        if not name.startswith(APPROVED_FLOOR_PREFIXES) or "collision" not in name:
            continue
        records[name] = {
            "name": name,
            "body": mujoco.mj_id2name(
                model,
                mujoco.mjtObj.mjOBJ_BODY,
                int(model.geom_bodyid[geom_id]),
            ),
            "type": int(model.geom_type[geom_id]),
            "size": [float(value) for value in model.geom_size[geom_id]],
            "pos": [float(value) for value in model.geom_pos[geom_id]],
            "contype": int(model.geom_contype[geom_id]),
            "conaffinity": int(model.geom_conaffinity[geom_id]),
        }
    return records


def _foot_geom_preservation(
    *,
    source_mjcf: Path,
    fembot_mjcf: Path,
) -> dict[str, Any]:
    source = _compiled_foot_collision_geoms(source_mjcf)
    fembot = _compiled_foot_collision_geoms(fembot_mjcf)
    missing = sorted(set(source) - set(fembot))
    added = sorted(set(fembot) - set(source))
    changed = []
    for name in sorted(set(source) & set(fembot)):
        source_record = source[name]
        fembot_record = fembot[name]
        size_delta = float(
            np.max(
                np.abs(
                    np.asarray(source_record["size"], dtype=np.float64)
                    - np.asarray(fembot_record["size"], dtype=np.float64)
                )
            )
        )
        pos_delta = float(
            np.max(
                np.abs(
                    np.asarray(source_record["pos"], dtype=np.float64)
                    - np.asarray(fembot_record["pos"], dtype=np.float64)
                )
            )
        )
        metadata_changed = any(
            source_record[key] != fembot_record[key]
            for key in ("type", "contype", "conaffinity")
        )
        if size_delta > 1.0e-12 or pos_delta > 1.0e-12 or metadata_changed:
            changed.append(
                {
                    "name": name,
                    "size_delta_max_m": size_delta,
                    "pos_delta_max_m": pos_delta,
                    "metadata_changed": metadata_changed,
                }
            )
    return {
        "source_geom_count": len(source),
        "fembot_geom_count": len(fembot),
        "missing_geoms": missing,
        "added_geoms": added,
        "changed_geoms": changed,
        "preserved": not missing and not added and not changed and len(fembot) >= 20,
        "fembot_geoms": [fembot[name] for name in sorted(fembot)],
    }


def _floor_contact_summary(collision_sweep_report: dict[str, Any]) -> dict[str, Any]:
    floor_contacts = []
    non_foot_floor_contacts = []
    for sample in collision_sweep_report.get("samples", []):
        label = str(sample.get("label"))
        for contact in sample.get("contacts", []):
            geom1 = str(contact.get("geom1"))
            geom2 = str(contact.get("geom2"))
            if "floor" not in (geom1, geom2):
                continue
            other = geom2 if geom1 == "floor" else geom1
            record = {
                "sample": label,
                "geom": other,
                "distance_m": contact.get("distance_m"),
                "approved": bool(contact.get("approved")),
            }
            floor_contacts.append(record)
            if not other.startswith(APPROVED_FLOOR_PREFIXES):
                non_foot_floor_contacts.append(record)
    neutral_floor_contacts = [
        contact for contact in floor_contacts if contact["sample"] == "neutral"
    ]
    return {
        "floor_contact_count": len(floor_contacts),
        "neutral_floor_contact_count": len(neutral_floor_contacts),
        "approved_floor_contact_count": sum(1 for contact in floor_contacts if contact["approved"]),
        "non_foot_floor_contact_count": len(non_foot_floor_contacts),
        "non_foot_floor_contacts": non_foot_floor_contacts[:20],
        "approved_floor_prefixes": list(APPROVED_FLOOR_PREFIXES),
        "accepted": bool(floor_contacts and not non_foot_floor_contacts),
    }


def _foot_plate_records(
    *,
    generated_cad_report: dict[str, Any],
    material_report: dict[str, Any],
    surface_report: dict[str, Any],
) -> list[dict[str, Any]]:
    generated_by_link = {
        str(record.get("link")): record
        for record in generated_cad_report.get("link_steps", [])
        if str(record.get("link")) in FOOT_LINKS
    }
    material_by_link = {
        str(record.get("part_id")): record
        for record in material_report.get("generated_parts", [])
        if str(record.get("part_id")) in FOOT_LINKS
    }
    generated_surface_by_link = {
        str(surface.get("link")): surface
        for group in surface_report.get("generated_body_groups", [])
        if group.get("group") == "foot"
        for surface in group.get("surfaces", [])
    }
    records = []
    for link in FOOT_LINKS:
        generated = generated_by_link.get(link, {})
        adjusted = generated.get("manufacturing_adjusted_plate") or {}
        material = material_by_link.get(link, {})
        surface = generated_surface_by_link.get(link, {})
        records.append(
            {
                "link": link,
                "shape_family": generated.get("shape_family"),
                "surface_intent": generated.get("surface_intent"),
                "flatness_error_m": surface.get("flatness_error_m"),
                "generated_surface_check_ok": bool(surface.get("generated_surface_check_ok")),
                "material_class": material.get("material_class"),
                "nominal_wall_thickness_ok": bool(material.get("wall_thickness_ok")),
                "manufacturing_adjusted_wall_thickness_ok": bool(
                    material.get("manufacturing_adjusted_wall_thickness_ok")
                ),
                "manufacturing_adjusted_process_floor_satisfied": bool(
                    adjusted.get("process_floor_satisfied")
                ),
                "manufacturing_adjusted_height_delta_m": adjusted.get("height_delta_m"),
                "manufacturing_adjusted_step_path": adjusted.get("step_path"),
                "accepted": bool(
                    generated.get("shape_family") == "flat_plate_envelope"
                    and generated.get("surface_intent") == "flat"
                    and surface.get("generated_surface_check_ok")
                    and material.get("material_class") == "ALU_7075"
                    and material.get("manufacturing_adjusted_wall_thickness_ok")
                    and adjusted.get("process_floor_satisfied")
                    and abs(float(adjusted.get("height_delta_m") or 0.0)) <= 1.0e-12
                ),
            }
        )
    return records


def build_fembot_foot_handling_proof(
    body_groups: list[dict[str, Any]],
    *,
    source_mjcf: Path = ASIMOV1_GENERATED_MJCF,
    fembot_mjcf_report: dict[str, Any] | None = None,
    collision_sweep_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    material_report: dict[str, Any] | None = None,
    surface_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fembot_mjcf = fembot_mjcf_report or generate_fembot_mjcf()
    fembot_mjcf_path = Path(str(fembot_mjcf.get("output", {}).get("mjcf", source_mjcf)))
    collision = collision_sweep_report or build_asimov1_collision_sweep_proof(
        mjcf_path=fembot_mjcf_path
    )
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    material = material_report or build_fembot_material_manufacturing_proof(
        body_groups,
        generated_cad_report=generated,
    )
    surface = surface_report or build_fembot_surface_quality_proof(
        body_groups,
        generated_cad_report=generated,
    )
    geom_preservation = _foot_geom_preservation(
        source_mjcf=source_mjcf,
        fembot_mjcf=fembot_mjcf_path,
    )
    floor_contact = _floor_contact_summary(collision)
    foot_plates = _foot_plate_records(
        generated_cad_report=generated,
        material_report=material,
        surface_report=surface,
    )
    accepted = bool(
        fembot_mjcf.get("ok")
        and collision.get("accepted")
        and geom_preservation["preserved"]
        and floor_contact["accepted"]
        and len(foot_plates) == 2
        and all(record["accepted"] for record in foot_plates)
    )
    return {
        "schema": FEMBOT_FOOT_HANDLING_SCHEMA,
        "ok": bool(fembot_mjcf.get("ok") and collision.get("ok") and generated.get("ok")),
        "accepted": accepted,
        "source": {
            "source_mjcf": str(source_mjcf),
            "fembot_mjcf": str(fembot_mjcf_path),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "collision_schema": collision.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "material_schema": material.get("schema"),
            "surface_schema": surface.get("schema"),
        },
        "summary": {
            "foot_links": list(FOOT_LINKS),
            "foot_collision_geoms_preserved": geom_preservation["preserved"],
            "fembot_foot_collision_geoms": geom_preservation["fembot_geom_count"],
            "floor_contact_count": floor_contact["floor_contact_count"],
            "neutral_floor_contact_count": floor_contact["neutral_floor_contact_count"],
            "approved_floor_contact_count": floor_contact["approved_floor_contact_count"],
            "non_foot_floor_contact_count": floor_contact["non_foot_floor_contact_count"],
            "collision_sweep_accepted": bool(collision.get("accepted")),
            "flat_foot_plate_count": sum(
                1
                for record in foot_plates
                if record.get("shape_family") == "flat_plate_envelope"
                and record.get("surface_intent") == "flat"
            ),
            "manufacturing_adjusted_foot_plate_count": sum(
                1
                for record in foot_plates
                if record.get("manufacturing_adjusted_process_floor_satisfied")
            ),
            "foot_flatness_ok_count": sum(
                1 for record in foot_plates if record.get("generated_surface_check_ok")
            ),
            "accepted": accepted,
            "acceptance_blocker": (
                None
                if accepted
                else "foot handling still needs preserved collision geoms, approved floor contacts, and flat manufacturable toe plates"
            ),
        },
        "geom_preservation": geom_preservation,
        "floor_contact": floor_contact,
        "foot_plates": foot_plates,
    }


def dump_fembot_foot_handling_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_foot_handling_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-foot-handling.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_foot_handling_proof_json(report), encoding="utf-8")
    return output
