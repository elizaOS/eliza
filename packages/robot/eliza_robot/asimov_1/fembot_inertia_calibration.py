"""Mass and inertia calibration readiness proof for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.fembot_materials import build_fembot_material_manufacturing_proof
from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_INERTIA_CALIBRATION_SCHEMA = "asimov-fembot-inertia-calibration-proof-v1"
MASS_RELATIVE_DELTA_TOLERANCE = 0.10
INERTIA_RELATIVE_DELTA_TOLERANCE = 0.25
LINK_BODY_ALIASES = {
    "IMU_ORIGIN": "pelvis_link",
    "LEFT_ANKLE_A": "left_ankle_pitch_link",
    "RIGHT_ANKLE_A": "right_ankle_pitch_link",
    "LEFT_ANKLE_B": "left_ankle_roll_link",
    "RIGHT_ANKLE_B": "right_ankle_roll_link",
}


def _link_to_body_name(link: str) -> str:
    return LINK_BODY_ALIASES.get(link, f"{link.lower()}_link")


def _compiled_body_records(mjcf_path: Path) -> dict[str, dict[str, Any]]:
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    records: dict[str, dict[str, Any]] = {}
    for body_id in range(1, int(model.nbody)):
        body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)
        if not body_name:
            continue
        records[body_name] = {
            "body": body_name,
            "body_id": body_id,
            "compiled_mass_kg": float(model.body_mass[body_id]),
            "compiled_diagonal_inertia_kg_m2": [
                float(value) for value in model.body_inertia[body_id]
            ],
        }
    return records


def _material_parts_by_link(material_report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("part_id")): record
        for record in material_report.get("generated_parts", [])
        if record.get("part_id")
    }


def _hardware_measurement_records_by_link(
    hardware_measurements: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    if not hardware_measurements:
        return {}
    records = hardware_measurements.get("links", {})
    if isinstance(records, dict):
        return {
            str(link).upper(): record
            for link, record in records.items()
            if isinstance(record, dict)
        }
    if isinstance(records, list):
        return {
            str(record.get("link")).upper(): record
            for record in records
            if isinstance(record, dict) and record.get("link")
        }
    return {}


def _relative_delta(reference: float, value: float) -> float | None:
    if abs(reference) <= 1.0e-18:
        return None
    return (value - reference) / reference


def _scale_to_reference(value: float | None, reference: float | None) -> float | None:
    if value is None or reference is None or abs(value) <= 1.0e-18:
        return None
    return reference / value


def build_fembot_inertia_calibration_proof(
    body_groups: list[dict[str, Any]],
    *,
    source_mjcf: Path = ASIMOV1_GENERATED_MJCF,
    fembot_mjcf_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    material_report: dict[str, Any] | None = None,
    hardware_measurements: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fembot_mjcf = fembot_mjcf_report or generate_fembot_mjcf(source_mjcf=source_mjcf)
    fembot_mjcf_path = Path(str(fembot_mjcf.get("output", {}).get("mjcf", source_mjcf)))
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    material = material_report or build_fembot_material_manufacturing_proof(
        body_groups,
        generated_cad_report=generated,
    )
    compiled_by_body = _compiled_body_records(fembot_mjcf_path)
    material_by_link = _material_parts_by_link(material)
    measured_by_link = _hardware_measurement_records_by_link(hardware_measurements)

    records = []
    missing_compiled = []
    missing_material = []
    missing_hardware = []
    for group in body_groups:
        for raw_link in group.get("links", []):
            link = str(raw_link).upper()
            body_name = _link_to_body_name(link)
            compiled = compiled_by_body.get(body_name)
            material_part = material_by_link.get(link)
            measured = measured_by_link.get(link)
            measurement_accepted = bool(measured and measured.get("accepted"))
            if compiled is None:
                missing_compiled.append(link)
            if material_part is None:
                missing_material.append(link)
            if not measurement_accepted:
                missing_hardware.append(link)
            cad_mass = (
                float(material_part.get("mass_estimate_kg"))
                if material_part and material_part.get("mass_estimate_kg") is not None
                else None
            )
            compiled_mass = (
                float(compiled["compiled_mass_kg"]) if compiled is not None else None
            )
            bbox_inertia = (
                material_part.get("bbox_inertia_estimate", {}) if material_part else {}
            )
            cad_inertia = [
                bbox_inertia.get("ixx_kg_m2"),
                bbox_inertia.get("iyy_kg_m2"),
                bbox_inertia.get("izz_kg_m2"),
            ]
            cad_inertia_values = [
                float(value) if value is not None else None for value in cad_inertia
            ]
            compiled_inertia = (
                [float(value) for value in compiled["compiled_diagonal_inertia_kg_m2"]]
                if compiled is not None
                else [None, None, None]
            )
            inertia_relative_delta = [
                _relative_delta(float(cad), float(comp))
                if cad is not None and comp is not None
                else None
                for cad, comp in zip(cad_inertia_values, compiled_inertia, strict=True)
            ]
            mass_scale_to_compiled = _scale_to_reference(cad_mass, compiled_mass)
            required_added_mass = (
                max(float(compiled_mass) - float(cad_mass), 0.0)
                if cad_mass is not None and compiled_mass is not None
                else None
            )
            inertia_scale_to_compiled = [
                _scale_to_reference(cad, comp)
                if cad is not None and comp is not None
                else None
                for cad, comp in zip(cad_inertia_values, compiled_inertia, strict=True)
            ]
            mass_delta_abs = (
                abs(float(_relative_delta(cad_mass, compiled_mass)))
                if cad_mass is not None and compiled_mass is not None
                else None
            )
            inertia_delta_abs = [
                abs(float(value)) if value is not None and np.isfinite(float(value)) else None
                for value in inertia_relative_delta
            ]
            mass_within_tolerance = bool(
                mass_delta_abs is not None
                and mass_delta_abs <= MASS_RELATIVE_DELTA_TOLERANCE
            )
            inertia_within_tolerance = bool(
                inertia_delta_abs
                and all(
                    value is not None and value <= INERTIA_RELATIVE_DELTA_TOLERANCE
                    for value in inertia_delta_abs
                )
            )
            records.append(
                {
                    "link": link,
                    "group": group.get("group"),
                    "body": body_name,
                    "compiled_mass_kg": compiled_mass,
                    "cad_material_mass_estimate_kg": cad_mass,
                    "mass_relative_delta_vs_cad": (
                        _relative_delta(cad_mass, compiled_mass)
                        if cad_mass is not None and compiled_mass is not None
                        else None
                    ),
                    "compiled_diagonal_inertia_kg_m2": compiled_inertia,
                    "cad_bbox_diagonal_inertia_kg_m2": cad_inertia_values,
                    "inertia_relative_delta_vs_cad": inertia_relative_delta,
                    "mass_scale_to_compiled": mass_scale_to_compiled,
                    "required_added_mass_to_match_compiled_kg": required_added_mass,
                    "inertia_scale_to_compiled": inertia_scale_to_compiled,
                    "mass_within_tolerance": mass_within_tolerance,
                    "inertia_within_tolerance": inertia_within_tolerance,
                    "calibration_action": (
                        "hardware_measurement_required"
                        if not measurement_accepted
                        else "calibrate_against_hardware_measurement"
                    ),
                    "hardware_measurement_present": measurement_accepted,
                    "hardware_measurement_requirement_count": (
                        measured.get("measurement_count") if measured else None
                    ),
                    "hardware_measurement_missing_count": (
                        measured.get("missing_measurement_count") if measured else None
                    ),
                    "hardware_measurement": measured,
                    "accepted": False,
                }
            )

    mass_deltas = [
        abs(float(record["mass_relative_delta_vs_cad"]))
        for record in records
        if record.get("mass_relative_delta_vs_cad") is not None
    ]
    inertia_deltas = [
        abs(float(value))
        for record in records
        for value in record.get("inertia_relative_delta_vs_cad", [])
        if value is not None and np.isfinite(float(value))
    ]
    measured_count = len(records) - len(missing_hardware)
    added_masses = [
        float(record["required_added_mass_to_match_compiled_kg"])
        for record in records
        if record.get("required_added_mass_to_match_compiled_kg") is not None
    ]
    mass_scale_factors = [
        float(record["mass_scale_to_compiled"])
        for record in records
        if record.get("mass_scale_to_compiled") is not None
        and np.isfinite(float(record["mass_scale_to_compiled"]))
    ]
    inertia_scale_factors = [
        float(value)
        for record in records
        for value in record.get("inertia_scale_to_compiled", [])
        if value is not None and np.isfinite(float(value))
    ]
    mass_out_of_tolerance = [
        record["link"] for record in records if not record["mass_within_tolerance"]
    ]
    inertia_out_of_tolerance = [
        record["link"] for record in records if not record["inertia_within_tolerance"]
    ]
    accepted = bool(
        records
        and not missing_compiled
        and not missing_material
        and measured_count == len(records)
    )
    return {
        "schema": FEMBOT_INERTIA_CALIBRATION_SCHEMA,
        "ok": bool(
            fembot_mjcf.get("ok")
            and generated.get("ok")
            and not missing_compiled
            and not missing_material
            and len(records) == 28
        ),
        "accepted": accepted,
        "source": {
            "source_mjcf": str(source_mjcf),
            "fembot_mjcf": str(fembot_mjcf_path),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "generated_cad_schema": generated.get("schema"),
            "material_schema": material.get("schema"),
            "hardware_measurement_schema": (hardware_measurements or {}).get("schema"),
        },
        "summary": {
            "links": len(records),
            "compiled_body_records": len(compiled_by_body),
            "mass_relative_delta_tolerance": MASS_RELATIVE_DELTA_TOLERANCE,
            "inertia_relative_delta_tolerance": INERTIA_RELATIVE_DELTA_TOLERANCE,
            "missing_compiled_links": sorted(missing_compiled),
            "missing_material_links": sorted(missing_material),
            "hardware_measured_links": measured_count,
            "missing_hardware_links": sorted(missing_hardware),
            "hardware_measurement_schema": (hardware_measurements or {}).get("schema"),
            "hardware_measurement_required_links": len(measured_by_link),
            "cad_mass_estimate_kg": sum(
                float(record["cad_material_mass_estimate_kg"] or 0.0)
                for record in records
            ),
            "compiled_total_mass_kg": fembot_mjcf.get("mass_inertia", {}).get(
                "total_mass_kg"
            ),
            "max_abs_mass_relative_delta_vs_cad": max(mass_deltas, default=None),
            "max_abs_inertia_relative_delta_vs_cad": max(inertia_deltas, default=None),
            "mass_out_of_tolerance_links": sorted(mass_out_of_tolerance),
            "inertia_out_of_tolerance_links": sorted(inertia_out_of_tolerance),
            "mass_out_of_tolerance_count": len(mass_out_of_tolerance),
            "inertia_out_of_tolerance_count": len(inertia_out_of_tolerance),
            "total_required_added_mass_to_match_compiled_kg": sum(added_masses),
            "max_required_added_mass_to_match_compiled_kg": max(added_masses, default=None),
            "max_mass_scale_to_compiled": max(mass_scale_factors, default=None),
            "max_inertia_scale_to_compiled": max(inertia_scale_factors, default=None),
            "calibration_ready": bool(
                records and not missing_compiled and not missing_material
            ),
            "accepted": accepted,
            "acceptance_blocker": (
                None
                if accepted
                else "compiled MuJoCo inertias are mapped to generated CAD/material estimates, but hardware-identified mass/inertia measurements are missing"
            ),
        },
        "link_inertia_records": records,
    }


def dump_fembot_inertia_calibration_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_inertia_calibration_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-inertia-calibration.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_inertia_calibration_proof_json(report), encoding="utf-8")
    return output
