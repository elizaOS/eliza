"""Material and manufacturing proof scaffolding for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

MATERIAL_BASELINES: dict[str, dict[str, Any]] = {
    "ALU_7075": {
        "material": "7075 aluminum",
        "density_kg_m3": 2810,
        "elastic_modulus_pa": 71.7e9,
        "yield_strength_pa": 503e6,
        "allowable_stress_pa": 250e6,
        "source": "conservative common 7075-T6 engineering baseline; verify exact temper before release",
    },
    "SML_316L": {
        "material": "316L stainless steel",
        "density_kg_m3": 8000,
        "elastic_modulus_pa": 193e9,
        "yield_strength_pa": 170e6,
        "allowable_stress_pa": 85e6,
        "source": "conservative annealed/low-strength 316L engineering baseline; verify stock/process before release",
    },
    "MJF_PA12": {
        "material": "PA12 nylon",
        "density_kg_m3": 1010,
        "elastic_modulus_pa": 1.6e9,
        "yield_strength_pa": 45e6,
        "allowable_stress_pa": 18e6,
        "source": "conservative MJF PA12 baseline; replace with vendor build-direction data before release",
    },
    "OFF_THE_SHELF": {
        "material": "vendor-defined off-the-shelf component",
        "density_kg_m3": None,
        "elastic_modulus_pa": None,
        "yield_strength_pa": None,
        "allowable_stress_pa": None,
        "source": "vendor component; do not scale or infer material without datasheet",
    },
}


MANUFACTURING_BASELINES: dict[str, dict[str, Any]] = {
    "ALU_7075": {
        "process": "CNC machining or sheet/plate fabrication",
        "minimum_wall_thickness_m": 0.0015,
        "minimum_feature_size_m": 0.0010,
        "draft_angle_deg": None,
        "tolerance_class": "machined functional fits require drawing-specific tolerances",
        "requires_flatness_check": True,
        "requires_smoothness_check": False,
        "requires_tool_access_check": True,
    },
    "SML_316L": {
        "process": "sheet metal/laser cut or machined stainless",
        "minimum_wall_thickness_m": 0.0008,
        "minimum_feature_size_m": 0.0008,
        "draft_angle_deg": None,
        "tolerance_class": "sheet/plate process dependent; bend allowance required if formed",
        "requires_flatness_check": True,
        "requires_smoothness_check": False,
        "requires_tool_access_check": True,
    },
    "MJF_PA12": {
        "process": "MJF additive manufacturing or reconstructed molded shell",
        "minimum_wall_thickness_m": 0.0012,
        "minimum_feature_size_m": 0.0008,
        "draft_angle_deg": 1.0,
        "tolerance_class": "process/vendor dependent; molded shell requires draft and undercut analysis",
        "requires_flatness_check": False,
        "requires_smoothness_check": True,
        "requires_tool_access_check": False,
    },
    "OFF_THE_SHELF": {
        "process": "purchased component",
        "minimum_wall_thickness_m": None,
        "minimum_feature_size_m": None,
        "draft_angle_deg": None,
        "tolerance_class": "vendor datasheet controls envelope and mounting pattern",
        "requires_flatness_check": False,
        "requires_smoothness_check": False,
        "requires_tool_access_check": False,
    },
}


def _selected_generated_material_class(record: dict[str, Any]) -> str:
    if record.get("surface_intent") == "flat":
        return "ALU_7075"
    return "MJF_PA12"


def _generated_part_record(record: dict[str, Any]) -> dict[str, Any]:
    material_class = _selected_generated_material_class(record)
    material = MATERIAL_BASELINES[material_class]
    manufacturing = MANUFACTURING_BASELINES[material_class]
    volume_m3 = float(record.get("reloaded_volume_m3") or 0.0)
    density = float(material["density_kg_m3"] or 0.0)
    mass_kg = volume_m3 * density
    extents = [float(value) for value in record["reloaded_bbox_extent_m"]]
    inertia_box = {
        "ixx_kg_m2": mass_kg / 12.0 * (extents[1] ** 2 + extents[2] ** 2),
        "iyy_kg_m2": mass_kg / 12.0 * (extents[0] ** 2 + extents[2] ** 2),
        "izz_kg_m2": mass_kg / 12.0 * (extents[0] ** 2 + extents[1] ** 2),
        "model": "solid bbox inertia upper-bound placeholder",
    }
    nominal_wall = (
        float(record["wall_thickness_m"])
        if record.get("wall_thickness_m") is not None
        else float(record.get("minimum_plate_thickness_m") or 0.0)
    )
    adjusted_plate = record.get("manufacturing_adjusted_plate") or {}
    adjusted_wall = (
        float(adjusted_plate["adjusted_design_thickness_m"])
        if adjusted_plate.get("adjusted_design_thickness_m") is not None
        else nominal_wall
    )
    process_wall = float(manufacturing["minimum_wall_thickness_m"] or 0.0)
    wall_ok = nominal_wall >= process_wall
    adjusted_wall_ok = adjusted_wall >= process_wall
    requires_draft_review = manufacturing["draft_angle_deg"] is not None
    requires_tool_access = bool(manufacturing["requires_tool_access_check"])
    geometry_measurements_present = bool(
        volume_m3 > 0.0
        and len(extents) == 3
        and all(float(value) > 0.0 for value in extents)
        and nominal_wall > 0.0
    )
    preliminary_mass_properties_present = bool(
        mass_kg > 0.0
        and all(float(value) > 0.0 for value in inertia_box.values() if isinstance(value, float))
    )
    return {
        "part_id": record["link"],
        "group": record["group"],
        "material_class": material_class,
        "material": material["material"],
        "density_kg_m3": material["density_kg_m3"],
        "elastic_modulus_pa": material["elastic_modulus_pa"],
        "yield_strength_pa": material["yield_strength_pa"],
        "allowable_stress_pa": material["allowable_stress_pa"],
        "source": material["source"],
        "process": manufacturing["process"],
        "minimum_wall_thickness_m": process_wall,
        "generated_nominal_wall_thickness_m": nominal_wall,
        "manufacturing_adjusted_wall_thickness_m": adjusted_wall,
        "wall_thickness_ok": wall_ok,
        "manufacturing_adjusted_wall_thickness_ok": adjusted_wall_ok,
        "minimum_feature_size_m": manufacturing["minimum_feature_size_m"],
        "draft_angle_deg": manufacturing["draft_angle_deg"],
        "undercut_count": None,
        "tool_access_ok": None if requires_tool_access else True,
        "tolerance_class": manufacturing["tolerance_class"],
        "requires_draft_review": requires_draft_review,
        "requires_tool_access_check": requires_tool_access,
        "requires_flatness_check": manufacturing["requires_flatness_check"],
        "requires_smoothness_check": manufacturing["requires_smoothness_check"],
        "geometry_measurements_present": geometry_measurements_present,
        "preliminary_mass_properties_present": preliminary_mass_properties_present,
        "reloaded_volume_m3": volume_m3,
        "mass_estimate_kg": mass_kg,
        "bbox_inertia_estimate": inertia_box,
        "accepted": False,
        "blocking_reason": (
            "generated part has local geometry, wall, material-class, and preliminary "
            "mass-property inputs, but manufacturing acceptance still needs released "
            "material/process selection, tolerance drawings, tool-access or draft/undercut "
            "proof where applicable, fastener/bearing features, and process-specific "
            "inspection evidence"
        ),
    }


def build_fembot_material_manufacturing_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify candidate STEP parts by material/process.

    This proof is intentionally not accepted for production by itself. It proves
    source classification coverage plus local generated-part geometry, wall, mass,
    and process-screen measurements; released production still needs the missing
    material/process validation gates surfaced in the summary.
    """
    group_reports = []
    unknown_candidates = []
    total_fabrication_candidates = 0

    for group in body_groups:
        candidates = [
            candidate
            for candidate in group.get("step_candidates", [])
            if candidate.get("fabrication_class") != "ASSEMBLY"
        ]
        total_fabrication_candidates += len(candidates)
        class_counts: dict[str, int] = {}
        material_records: dict[str, dict[str, Any]] = {}
        manufacturing_records: dict[str, dict[str, Any]] = {}
        for candidate in candidates:
            fabrication_class = str(candidate.get("fabrication_class", "unknown"))
            class_counts[fabrication_class] = class_counts.get(fabrication_class, 0) + 1
            material = MATERIAL_BASELINES.get(fabrication_class)
            manufacturing = MANUFACTURING_BASELINES.get(fabrication_class)
            if material is None or manufacturing is None:
                unknown_candidates.append(candidate.get("path"))
                continue
            material_records[fabrication_class] = material
            manufacturing_records[fabrication_class] = manufacturing

        classification_ok = bool(candidates) and not unknown_candidates
        group_reports.append(
            {
                "group": group["group"],
                "candidate_count": len(candidates),
                "fabrication_class_counts": dict(sorted(class_counts.items())),
                "material_records": material_records,
                "manufacturing_records": manufacturing_records,
                "classification_ok": classification_ok,
                "accepted": False,
                "blocking_reason": (
                    "candidate STEP folders are classified, and generated fembot parts "
                    "now carry local wall, volume, envelope, mass, and inertia estimates; "
                    "production release still needs exact material/process selection, "
                    "flatness/smoothness inspection, tool access, draft/undercut, "
                    "tolerance, and measured mass/inertia evidence"
                ),
            }
        )

    if generated_cad_report is None:
        from eliza_robot.asimov_1.fembot_generated_cad import (
            build_fembot_generated_cad_envelope_proof,
        )

        generated = build_fembot_generated_cad_envelope_proof(body_groups)
    else:
        generated = generated_cad_report
    generated_parts = [_generated_part_record(record) for record in generated.get("link_steps", [])]
    generated_wall_failures = [
        record for record in generated_parts if not record["wall_thickness_ok"]
    ]
    generated_adjusted_wall_failures = [
        record
        for record in generated_parts
        if not record["manufacturing_adjusted_wall_thickness_ok"]
    ]
    generated_tool_access_pending = [
        record for record in generated_parts if record["requires_tool_access_check"]
    ]
    generated_draft_pending = [record for record in generated_parts if record["requires_draft_review"]]
    generated_geometry_measurement_missing = [
        record for record in generated_parts if not record["geometry_measurements_present"]
    ]
    generated_preliminary_mass_missing = [
        record for record in generated_parts if not record["preliminary_mass_properties_present"]
    ]
    generated_adjusted_wall_ready = [
        record
        for record in generated_parts
        if record["manufacturing_adjusted_wall_thickness_ok"]
    ]
    generated_material_counts: dict[str, int] = {}
    generated_total_mass = 0.0
    for record in generated_parts:
        generated_material_counts[record["material_class"]] = (
            generated_material_counts.get(record["material_class"], 0) + 1
        )
        generated_total_mass += float(record.get("mass_estimate_kg") or 0.0)

    classification_ok = total_fabrication_candidates > 0 and not unknown_candidates
    generated_ok = bool(generated.get("ok") and len(generated_parts) == 28)
    return {
        "schema": "asimov-fembot-material-manufacturing-proof-v1",
        "ok": bool(classification_ok and generated_ok),
        "accepted": False,
        "summary": {
            "body_groups": len(group_reports),
            "fabrication_candidates": total_fabrication_candidates,
            "unknown_candidate_count": len(unknown_candidates),
            "classification_ok": classification_ok,
            "generated_part_records": len(generated_parts),
            "generated_material_class_counts": dict(sorted(generated_material_counts.items())),
            "generated_mass_estimate_kg": generated_total_mass,
            "generated_geometry_measurement_parts": (
                len(generated_parts) - len(generated_geometry_measurement_missing)
            ),
            "generated_geometry_measurement_missing_parts": len(
                generated_geometry_measurement_missing
            ),
            "generated_preliminary_mass_property_parts": (
                len(generated_parts) - len(generated_preliminary_mass_missing)
            ),
            "generated_preliminary_mass_property_missing_parts": len(
                generated_preliminary_mass_missing
            ),
            "generated_wall_thickness_failures": len(generated_wall_failures),
            "generated_adjusted_wall_thickness_failures": len(
                generated_adjusted_wall_failures
            ),
            "generated_adjusted_wall_thickness_ready_parts": len(
                generated_adjusted_wall_ready
            ),
            "generated_tool_access_pending_parts": len(generated_tool_access_pending),
            "generated_draft_review_pending_parts": len(generated_draft_pending),
            "production_material_selection_pending_parts": len(generated_parts),
            "production_tolerance_drawing_pending_parts": len(generated_parts),
            "production_inspection_pending_parts": len(generated_parts),
            "material_properties_accepted": False,
            "manufacturing_process_accepted": False,
            "acceptance_blocker": (
                "local material-class, generated geometry, adjusted wall, and preliminary "
                "mass-property screens are present; production acceptance still needs exact "
                "released materials/processes, tolerance drawings, process-specific "
                "draft/tool-access/inspection proof, fastener/bearing feature validation, "
                "and measured hardware mass/inertia"
            ),
        },
        "unknown_candidates": unknown_candidates,
        "body_groups": group_reports,
        "generated_parts": generated_parts,
    }


def write_fembot_material_manufacturing_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-material-manufacturing.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def dump_fembot_material_manufacturing_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"
