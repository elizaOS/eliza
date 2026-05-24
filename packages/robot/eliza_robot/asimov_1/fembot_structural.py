"""Preliminary structural sanity proof for ASIMOV fembot generated CAD."""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.cad import sha256_file
from eliza_robot.asimov_1.fembot_cad_toolchain import FEMBOT_CAD_ENV_VENV
from eliza_robot.asimov_1.fembot_generated_cad import (
    DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
    _internal_cavity_report,
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_materials import MANUFACTURING_BASELINES, MATERIAL_BASELINES
from eliza_robot.asimov_1.fembot_topology import build_fembot_topology_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

STRUCTURAL_SCHEMA = "asimov-fembot-structural-proof-v1"
DEFAULT_NOMINAL_LOAD_N = 50.0
DEFAULT_GRAVITY_M_S2 = 9.80665
DEFAULT_PROOF_ACCELERATION_G = 3.0
DEFAULT_LINK_LENGTH_FLOOR_M = 0.01
DEFAULT_BUCKLING_EFFECTIVE_LENGTH_FACTOR = 2.0
DEFAULT_STRUCTURAL_REMEDIATION_SAFETY_FACTOR_TARGET = 1.05
DEFAULT_STRUCTURAL_REMEDIATION_OUTPUT_ROOT = (
    ASIMOV_FEMININE_CAD_ROOT
    / "output"
    / "generated-cad"
    / "structural-remediation-preview-step"
)
DEFAULT_REMEDIATION_ENVELOPE_TOLERANCE_M = 1e-6


def _cad_python(venv: Path = FEMBOT_CAD_ENV_VENV) -> Path:
    return venv / "bin" / "python"


def _safe_filename(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in value).strip("_")


def _selected_material_class(record: dict[str, Any]) -> str:
    if record.get("surface_intent") == "flat":
        return "ALU_7075"
    return "MJF_PA12"


def _minimum_cross_section_area_m2(record: dict[str, Any]) -> float:
    extents = [float(value) for value in record["requested_extent_m"]]
    ordered = sorted(extents)
    return max(ordered[0] * ordered[1], 1e-9)


def _section_properties(record: dict[str, Any]) -> dict[str, float]:
    extents = sorted(float(value) for value in record["requested_extent_m"])
    minor_a = max(extents[0], 1e-6)
    minor_b = max(extents[1], 1e-6)
    length = max(extents[2], DEFAULT_LINK_LENGTH_FLOOR_M)
    area = max(minor_a * minor_b, 1e-9)
    section_modulus_a = minor_a * minor_b**2 / 6.0
    section_modulus_b = minor_b * minor_a**2 / 6.0
    inertia_a = minor_a * minor_b**3 / 12.0
    inertia_b = minor_b * minor_a**3 / 12.0
    return {
        "minor_axis_a_m": minor_a,
        "minor_axis_b_m": minor_b,
        "length_m": length,
        "area_m2": area,
        "section_modulus_m3": max(min(section_modulus_a, section_modulus_b), 1e-12),
        "second_moment_area_m4": max(min(inertia_a, inertia_b), 1e-15),
    }


def _mass_estimate_kg(record: dict[str, Any], material: dict[str, Any]) -> float:
    density = float(material["density_kg_m3"] or 0.0)
    return float(record.get("reloaded_volume_m3") or 0.0) * density


def _cantilever_bending_case(
    *,
    name: str,
    load_n: float,
    material: dict[str, Any],
    section: dict[str, float],
    model: str,
) -> dict[str, Any]:
    length = section["length_m"]
    moment = load_n * length
    stress = moment / section["section_modulus_m3"]
    modulus = float(material["elastic_modulus_pa"] or 0.0)
    deflection = (
        load_n * length**3 / (3.0 * modulus * section["second_moment_area_m4"])
        if modulus > 0.0
        else None
    )
    allowable = float(material["allowable_stress_pa"] or 0.0)
    safety_factor = allowable / stress if stress > 0.0 else None
    return {
        "name": name,
        "load_n": load_n,
        "model": model,
        "max_moment_nm": moment,
        "max_stress_pa": stress,
        "max_deflection_m": deflection,
        "allowable_stress_pa": allowable,
        "safety_factor": safety_factor,
        "accepted": bool(safety_factor is not None and safety_factor > 1.0),
        "blocking_reason": None
        if safety_factor is not None and safety_factor > 1.0
        else "analytic bending screen safety factor is not above 1.0",
    }


def _buckling_case(
    *,
    load_n: float,
    material: dict[str, Any],
    section: dict[str, float],
) -> dict[str, Any]:
    modulus = float(material["elastic_modulus_pa"] or 0.0)
    effective_length = DEFAULT_BUCKLING_EFFECTIVE_LENGTH_FACTOR * section["length_m"]
    critical_load = (
        math.pi**2 * modulus * section["second_moment_area_m4"] / effective_length**2
        if modulus > 0.0 and effective_length > 0.0
        else 0.0
    )
    safety_factor = critical_load / load_n if load_n > 0.0 else None
    return {
        "name": "preliminary_euler_buckling_screen",
        "load_n": load_n,
        "model": "cantilever effective-length Euler screen on conservative bbox minor inertia",
        "effective_length_factor": DEFAULT_BUCKLING_EFFECTIVE_LENGTH_FACTOR,
        "critical_load_n": critical_load,
        "safety_factor": safety_factor,
        "accepted": bool(safety_factor is not None and safety_factor > 1.0),
        "blocking_reason": None
        if safety_factor is not None and safety_factor > 1.0
        else "analytic buckling screen safety factor is not above 1.0",
    }


def _analytic_load_cases(
    record: dict[str, Any],
    *,
    material: dict[str, Any],
    mass_kg: float,
    section: dict[str, float],
) -> list[dict[str, Any]]:
    proof_load_n = mass_kg * DEFAULT_GRAVITY_M_S2 * DEFAULT_PROOF_ACCELERATION_G
    return [
        _cantilever_bending_case(
            name="preliminary_3g_self_weight_cantilever_bending",
            load_n=proof_load_n,
            material=material,
            section=section,
            model="3g generated-part self-weight at link tip using conservative bbox section",
        ),
        _cantilever_bending_case(
            name="preliminary_50n_service_cantilever_bending",
            load_n=DEFAULT_NOMINAL_LOAD_N,
            material=material,
            section=section,
            model="50 N service screen at link tip using conservative bbox section",
        ),
        _buckling_case(
            load_n=max(DEFAULT_NOMINAL_LOAD_N, proof_load_n),
            material=material,
            section=section,
        ),
    ]


def _required_square_section_for_loads(
    *,
    load_n: float,
    material: dict[str, Any],
    length_m: float,
    safety_factor_target: float = DEFAULT_STRUCTURAL_REMEDIATION_SAFETY_FACTOR_TARGET,
) -> dict[str, Any]:
    allowable = float(material["allowable_stress_pa"] or 0.0)
    modulus = float(material["elastic_modulus_pa"] or 0.0)
    target_load = load_n * safety_factor_target
    bending_size = (
        (6.0 * target_load * length_m / allowable) ** (1.0 / 3.0)
        if allowable > 0.0 and load_n > 0.0 and length_m > 0.0
        else None
    )
    buckling_size = (
        (
            12.0
            * (DEFAULT_BUCKLING_EFFECTIVE_LENGTH_FACTOR * length_m) ** 2
            * target_load
            / (math.pi**2 * modulus)
        )
        ** 0.25
        if modulus > 0.0 and load_n > 0.0 and length_m > 0.0
        else None
    )
    required_size = max(
        value for value in (bending_size, buckling_size) if value is not None
    )
    return {
        "required_square_minor_axis_m": required_size,
        "bending_required_square_minor_axis_m": bending_size,
        "buckling_required_square_minor_axis_m": buckling_size,
        "safety_factor_target": safety_factor_target,
    }


def _structural_remediation(
    *,
    record: dict[str, Any],
    material: dict[str, Any],
    section: dict[str, float],
    load_cases: list[dict[str, Any]],
) -> dict[str, Any] | None:
    failed_cases = [case for case in load_cases if not case.get("accepted")]
    if not failed_cases:
        return None
    max_failed_load = max(float(case["load_n"]) for case in failed_cases)
    required = _required_square_section_for_loads(
        load_n=max_failed_load,
        material=material,
        length_m=section["length_m"],
    )
    current_minor = min(section["minor_axis_a_m"], section["minor_axis_b_m"])
    required_minor = float(required["required_square_minor_axis_m"])
    return {
        "link": record["link"],
        "group": record["group"],
        "material_class": _selected_material_class(record),
        "failed_load_cases": [case["name"] for case in failed_cases],
        "current_minor_axis_m": current_minor,
        "current_length_m": section["length_m"],
        **required,
        "minor_axis_increase_m": max(required_minor - current_minor, 0.0),
        "minor_axis_increase_fraction": (
            max(required_minor - current_minor, 0.0) / current_minor
            if current_minor > 0.0
            else None
        ),
        "height_preserved": True,
        "recommended_action": (
            "increase local section, add ribs/bridge cage, switch load path/material, "
            "or reduce assumed service load before production acceptance"
        ),
    }


def _export_structural_remediation_previews(
    *,
    remediation_plan: list[dict[str, Any]],
    generated_records_by_link: dict[str, dict[str, Any]],
    output_root: Path,
    cad_python: Path,
    timeout_s: int = 120,
) -> dict[str, Any]:
    if not remediation_plan:
        return {
            "ok": True,
            "backend": "cadquery",
            "python": str(cad_python),
            "output_root": str(output_root),
            "records": [],
            "failures": [],
        }
    if not cad_python.is_file():
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "output_root": str(output_root),
            "records": [],
            "failures": [{"error": "isolated CAD python executable not found"}],
        }
    specs = []
    for remediation in remediation_plan:
        link = str(remediation["link"]).upper()
        source = generated_records_by_link[link]
        requested_extent = [float(value) for value in source["requested_extent_m"]]
        adjusted_extent = list(requested_extent)
        required_minor = float(remediation["required_square_minor_axis_m"])
        adjusted_extent[0] = max(adjusted_extent[0], required_minor)
        adjusted_extent[1] = max(adjusted_extent[1], required_minor)
        specs.append(
            {
                "link": link,
                "group": source["group"],
                "material_class": remediation["material_class"],
                "requested_extent_m": requested_extent,
                "adjusted_extent_m": adjusted_extent,
                "requested_center_m": [float(value) for value in source["requested_center_m"]],
                "current_minor_axis_m": remediation["current_minor_axis_m"],
                "required_square_minor_axis_m": required_minor,
                "failed_load_cases": remediation["failed_load_cases"],
                "step_path": str(output_root / f"{_safe_filename(link)}.step"),
            }
        )
    code = r'''
from __future__ import annotations

import json
from pathlib import Path
import sys

import cadquery as cq

payload = json.loads(sys.stdin.read())
records = []
failures = []
for spec in payload["specs"]:
    step_path = Path(spec["step_path"])
    try:
        step_path.parent.mkdir(parents=True, exist_ok=True)
        extents = [float(value) for value in spec["adjusted_extent_m"]]
        center = [float(value) for value in spec["requested_center_m"]]
        solid = cq.Workplane("XY").box(extents[0], extents[1], extents[2], centered=True)
        solid = solid.translate(tuple(center))
        cq.exporters.export(solid, str(step_path))
        imported = cq.importers.importStep(str(step_path))
        bbox = imported.val().BoundingBox()
        records.append(
            {
                "link": spec["link"],
                "group": spec["group"],
                "material_class": spec["material_class"],
                "step_path": str(step_path),
                "requested_extent_m": spec["requested_extent_m"],
                "adjusted_extent_m": extents,
                "requested_center_m": center,
                "current_minor_axis_m": spec["current_minor_axis_m"],
                "required_square_minor_axis_m": spec["required_square_minor_axis_m"],
                "failed_load_cases": spec["failed_load_cases"],
                "reloaded_bbox_extent_m": [bbox.xlen, bbox.ylen, bbox.zlen],
                "reloaded_bbox_center_m": [
                    (bbox.xmin + bbox.xmax) * 0.5,
                    (bbox.ymin + bbox.ymax) * 0.5,
                    (bbox.zmin + bbox.zmax) * 0.5,
                ],
                "reloaded_volume_m3": imported.val().Volume(),
                "solid_count": len(imported.solids().vals()),
                "export_ok": step_path.is_file() and step_path.stat().st_size > 0,
                "reload_ok": True,
            }
        )
    except Exception as exc:
        failures.append(
            {
                "link": spec.get("link"),
                "step_path": str(step_path),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
print(json.dumps({"records": records, "failures": failures}, sort_keys=True))
'''
    try:
        proc = subprocess.run(
            [str(cad_python), "-c", code],
            input=json.dumps({"specs": specs}),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_s,
        )
    except Exception as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "output_root": str(output_root),
            "records": [],
            "failures": [{"error": f"{type(exc).__name__}: {exc}"}],
        }
    if proc.returncode != 0:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "output_root": str(output_root),
            "records": [],
            "failures": [{"error": proc.stderr.strip() or proc.stdout.strip()}],
        }
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "backend": "cadquery",
            "python": str(cad_python),
            "output_root": str(output_root),
            "records": [],
            "failures": [{"error": f"JSONDecodeError: {exc}", "stdout": proc.stdout}],
        }
    records = []
    for record in parsed.get("records", []):
        step_path = Path(record["step_path"])
        requested_extent = [float(value) for value in record["requested_extent_m"]]
        adjusted_extent = [float(value) for value in record["adjusted_extent_m"]]
        reloaded_extent = [float(value) for value in record["reloaded_bbox_extent_m"]]
        requested_center = [float(value) for value in record["requested_center_m"]]
        reloaded_center = [float(value) for value in record["reloaded_bbox_center_m"]]
        extent_error = [
            abs(got - adjusted)
            for got, adjusted in zip(reloaded_extent, adjusted_extent, strict=True)
        ]
        center_error = [
            abs(got - requested)
            for got, requested in zip(reloaded_center, requested_center, strict=True)
        ]
        records.append(
            {
                **record,
                "step_sha256": sha256_file(step_path) if step_path.is_file() else None,
                "step_size_bytes": step_path.stat().st_size if step_path.is_file() else 0,
                "height_delta_m": adjusted_extent[2] - requested_extent[2],
                "minor_axis_increase_m": (
                    float(record["required_square_minor_axis_m"])
                    - float(record["current_minor_axis_m"])
                ),
                "extent_max_abs_error_m": max(extent_error, default=None),
                "center_max_abs_error_m": max(center_error, default=None),
                "height_preserved": abs(adjusted_extent[2] - requested_extent[2])
                <= DEFAULT_REMEDIATION_ENVELOPE_TOLERANCE_M,
                "center_preserved": max(center_error, default=0.0)
                <= DEFAULT_REMEDIATION_ENVELOPE_TOLERANCE_M,
                "solid_count_ok": int(record["solid_count"]) == 1,
            }
        )
    return {
        "ok": not parsed.get("failures"),
        "backend": "cadquery",
        "python": str(cad_python),
        "output_root": str(output_root),
        "records": records,
        "failures": parsed.get("failures", []),
    }


def _slenderness_ratio(record: dict[str, Any]) -> float:
    extents = [float(value) for value in record["requested_extent_m"]]
    length = max(extents)
    minor = max(min(extents), DEFAULT_LINK_LENGTH_FLOOR_M)
    return length / minor


def _preview_load_screen_record(record: dict[str, Any]) -> dict[str, Any]:
    material_class = str(record["material_class"])
    material = MATERIAL_BASELINES[material_class]
    preview_record = {
        "requested_extent_m": record["adjusted_extent_m"],
        "reloaded_volume_m3": record["reloaded_volume_m3"],
    }
    section = _section_properties(preview_record)
    mass_kg = _mass_estimate_kg(preview_record, material)
    load_cases = _analytic_load_cases(
        preview_record,
        material=material,
        mass_kg=mass_kg,
        section=section,
    )
    finite_safety_factors = [
        float(case["safety_factor"])
        for case in load_cases
        if case.get("safety_factor") is not None
    ]
    finite_deflections = [
        float(case["max_deflection_m"])
        for case in load_cases
        if case.get("max_deflection_m") is not None
    ]
    return {
        "link": record["link"],
        "group": record["group"],
        "material_class": material_class,
        "mass_estimate_kg": mass_kg,
        "section_properties": section,
        "load_cases": load_cases,
        "minimum_safety_factor": min(finite_safety_factors, default=None),
        "max_deflection_m": max(finite_deflections, default=None),
        "accepted": all(case.get("accepted") for case in load_cases),
        "blocking_reason": None
        if all(case.get("accepted") for case in load_cases)
        else "structural remediation preview still fails an analytic screen",
    }


def _preview_thinness_impact_record(record: dict[str, Any]) -> dict[str, Any]:
    requested = [float(value) for value in record["requested_extent_m"]]
    adjusted = [float(value) for value in record["adjusted_extent_m"]]
    current_xy_area = requested[0] * requested[1]
    adjusted_xy_area = adjusted[0] * adjusted[1]
    width_increase = adjusted[0] - requested[0]
    depth_increase = adjusted[1] - requested[1]
    return {
        "link": record["link"],
        "group": record["group"],
        "current_width_m": requested[0],
        "current_depth_m": requested[1],
        "adjusted_width_m": adjusted[0],
        "adjusted_depth_m": adjusted[1],
        "width_increase_m": width_increase,
        "depth_increase_m": depth_increase,
        "max_minor_axis_increase_m": max(width_increase, depth_increase),
        "current_xy_area_m2": current_xy_area,
        "adjusted_xy_area_m2": adjusted_xy_area,
        "xy_area_increase_m2": adjusted_xy_area - current_xy_area,
        "xy_area_increase_fraction": (
            (adjusted_xy_area - current_xy_area) / current_xy_area
            if current_xy_area > 0.0
            else None
        ),
        "height_delta_m": record["height_delta_m"],
    }


def _preview_internal_cavity_impact_record(
    record: dict[str, Any],
    *,
    generated_records_by_link: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    link = str(record["link"]).upper()
    source = generated_records_by_link[link]
    source_cavity = source.get("internal_cavity") or {}
    wall_thickness = source_cavity.get("wall_thickness_m")
    adjusted_cavity = _internal_cavity_report(
        center=[float(value) for value in record["requested_center_m"]],
        extents=[float(value) for value in record["adjusted_extent_m"]],
        wall_thickness_m=float(wall_thickness) if wall_thickness is not None else None,
        keepout_points=[
            {
                "component_type": point.get("component_type"),
                "name": point.get("name"),
                "point_m": [float(value) for value in point["point_m"]],
                "component_radius_m": float(point.get("component_radius_m") or 0.0),
            }
            for point in source_cavity.get("points", [])
        ],
        margin_m=DEFAULT_INTERNAL_KEEPOUT_MARGIN_M,
    )
    current_violation_count = int(source_cavity.get("violation_count") or 0)
    adjusted_violation_count = int(adjusted_cavity.get("violation_count") or 0)
    current_minimum_clearance = source_cavity.get("minimum_projected_clearance_m")
    adjusted_minimum_clearance = adjusted_cavity.get("minimum_projected_clearance_m")
    return {
        "link": link,
        "group": record["group"],
        "model": (
            "bbox internal cavity proxy using structural-remediation preview X/Y "
            "extents, preserved Z extent, original keepout spheres, and generated "
            "wall thickness"
        ),
        "current_extent_m": [float(value) for value in source["requested_extent_m"]],
        "adjusted_extent_m": [float(value) for value in record["adjusted_extent_m"]],
        "height_delta_m": record["height_delta_m"],
        "wall_thickness_m": adjusted_cavity.get("wall_thickness_m"),
        "keepout_point_count": int(adjusted_cavity.get("keepout_point_count") or 0),
        "current_violation_count": current_violation_count,
        "adjusted_violation_count": adjusted_violation_count,
        "violation_count_delta": adjusted_violation_count - current_violation_count,
        "current_minimum_projected_clearance_m": current_minimum_clearance,
        "adjusted_minimum_projected_clearance_m": adjusted_minimum_clearance,
        "minimum_projected_clearance_delta_m": (
            float(adjusted_minimum_clearance) - float(current_minimum_clearance)
            if adjusted_minimum_clearance is not None and current_minimum_clearance is not None
            else None
        ),
        "improves_internal_cavity": adjusted_violation_count < current_violation_count,
        "clears_internal_cavity": adjusted_violation_count == 0,
        "requires_z_pocket_or_component_refinement": any(
            point.get("violates_internal_cavity")
            and str(point.get("limiting_axis")) == "z"
            for point in adjusted_cavity.get("points", [])
        ),
        "adjusted_internal_cavity": adjusted_cavity,
    }


def _link_structural_record(
    record: dict[str, Any],
    *,
    topology_repair: dict[str, Any] | None = None,
) -> dict[str, Any]:
    material_class = _selected_material_class(record)
    material = MATERIAL_BASELINES[material_class]
    manufacturing = MANUFACTURING_BASELINES[material_class]
    wall = (
        float(record["wall_thickness_m"])
        if record.get("wall_thickness_m") is not None
        else float(record.get("minimum_plate_thickness_m") or 0.0)
    )
    minimum_process_wall = float(manufacturing["minimum_wall_thickness_m"] or 0.0)
    adjusted_plate = record.get("manufacturing_adjusted_plate") or {}
    adjusted_wall = (
        float(adjusted_plate["adjusted_design_thickness_m"])
        if adjusted_plate.get("adjusted_design_thickness_m") is not None
        else wall
    )
    area = _minimum_cross_section_area_m2(record)
    section = _section_properties(record)
    mass_kg = _mass_estimate_kg(record, material)
    load_cases = _analytic_load_cases(
        record,
        material=material,
        mass_kg=mass_kg,
        section=section,
    )
    remediation = _structural_remediation(
        record=record,
        material=material,
        section=section,
        load_cases=load_cases,
    )
    finite_stresses = [
        float(case["max_stress_pa"])
        for case in load_cases
        if case.get("max_stress_pa") is not None
    ]
    finite_deflections = [
        float(case["max_deflection_m"])
        for case in load_cases
        if case.get("max_deflection_m") is not None
    ]
    finite_safety_factors = [
        float(case["safety_factor"])
        for case in load_cases
        if case.get("safety_factor") is not None
    ]
    nominal_stress = max(finite_stresses, default=DEFAULT_NOMINAL_LOAD_N / area)
    allowable = float(material["allowable_stress_pa"] or 0.0)
    safety_factor = min(finite_safety_factors, default=None)
    cavity_violations = int(record.get("internal_cavity", {}).get("violation_count") or 0)
    volume_adjusted_violations = int(
        record.get("volume_adjusted_candidate", {})
        .get("internal_cavity", {})
        .get("violation_count")
        or 0
    )
    return {
        "part_id": record["link"],
        "group": record["group"],
        "material_class": material_class,
        "material": material["material"],
        "process": manufacturing["process"],
        "mass_estimate_kg": mass_kg,
        "section_properties": section,
        "load_cases": load_cases,
        "structural_remediation": remediation,
        "minimum_wall_thickness_m": wall,
        "minimum_process_wall_thickness_m": minimum_process_wall,
        "wall_thickness_ok": wall >= minimum_process_wall,
        "manufacturing_adjusted_wall_thickness_m": adjusted_wall,
        "manufacturing_adjusted_wall_thickness_ok": adjusted_wall >= minimum_process_wall,
        "manufacturing_adjusted_thickness_increase_m": (
            float(adjusted_plate.get("thickness_increase_m") or 0.0)
        ),
        "manufacturing_adjusted_step_path": adjusted_plate.get("step_path"),
        "manufacturing_adjusted_step_sha256": adjusted_plate.get("step_sha256"),
        "minimum_cross_section_area_m2": area,
        "max_stress_pa": nominal_stress,
        "allowable_stress_pa": allowable,
        "minimum_safety_factor": safety_factor,
        "max_deflection_m": max(finite_deflections, default=None),
        "slenderness_ratio": _slenderness_ratio(record),
        "internal_cavity_violation_count": cavity_violations,
        "volume_adjusted_violation_count": volume_adjusted_violations,
        "ribbed_preview_required": record["link"]
        in {
            "RIGHT_ELBOW",
            "LEFT_ELBOW",
            "LEFT_ANKLE_B",
            "RIGHT_ANKLE_B",
        },
        "topology_repair_preview_available": bool(topology_repair),
        "topology_repair_preview_step_path": (
            topology_repair.get("repair_step") if topology_repair else None
        ),
        "topology_repair_preview_step_sha256": (
            topology_repair.get("repair_step_sha256") if topology_repair else None
        ),
        "topology_repair_preview_envelope_preserved": bool(
            topology_repair and topology_repair.get("envelope_preserved")
        ),
        "topology_repair_preview_height_preserved": bool(
            topology_repair and topology_repair.get("height_preserved")
        ),
        "topology_repair_preview_volume_delta_fraction": (
            topology_repair.get("volume_delta_fraction") if topology_repair else None
        ),
        "accepted": False,
        "blocking_reason": (
            "preliminary wall and section checks exist, but structural acceptance "
            "requires exact material/process assignment, link-specific load cases, "
            "fastener edge-distance checks, deflection/buckling analysis, and FEA or equivalent"
        ),
    }


def build_fembot_structural_sanity_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    generated_topology_report: dict[str, Any] | None = None,
    structural_remediation_root: Path = DEFAULT_STRUCTURAL_REMEDIATION_OUTPUT_ROOT,
) -> dict[str, Any]:
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    generated_records_by_link = {
        str(record.get("link", "")).upper(): record
        for record in generated.get("link_steps", [])
    }
    topology = generated_topology_report or build_fembot_topology_proof(
        generated_cad_report=generated
    )
    topology_repairs = {
        str(record.get("link", "")).upper(): record
        for record in topology.get("repair_preview_topology", [])
        if record.get("accepted")
    }
    link_records = [
        _link_structural_record(
            record,
            topology_repair=topology_repairs.get(str(record.get("link", "")).upper()),
        )
        for record in generated.get("link_steps", [])
    ]
    wall_failures = [record for record in link_records if not record["wall_thickness_ok"]]
    adjusted_wall_failures = [
        record for record in link_records if not record["manufacturing_adjusted_wall_thickness_ok"]
    ]
    cavity_blockers = [
        record for record in link_records if int(record["internal_cavity_violation_count"]) > 0
    ]
    volume_blockers = [
        record for record in link_records if int(record["volume_adjusted_violation_count"]) > 0
    ]
    finite_safety_factors = [
        float(record["minimum_safety_factor"])
        for record in link_records
        if record.get("minimum_safety_factor") is not None
    ]
    analytic_load_cases = [
        case for record in link_records for case in record.get("load_cases", [])
    ]
    failed_analytic_load_cases = [
        case for case in analytic_load_cases if not case.get("accepted")
    ]
    analytic_failure_links = sorted(
        {
            record["part_id"]
            for record in link_records
            if any(not case.get("accepted") for case in record.get("load_cases", []))
        }
    )
    structural_remediation_plan = sorted(
        [
            record["structural_remediation"]
            for record in link_records
            if record.get("structural_remediation")
        ],
        key=lambda item: float(item["minor_axis_increase_m"]),
        reverse=True,
    )
    structural_remediation_preview = _export_structural_remediation_previews(
        remediation_plan=structural_remediation_plan,
        generated_records_by_link=generated_records_by_link,
        output_root=structural_remediation_root,
        cad_python=_cad_python(),
    )
    structural_remediation_preview_records = structural_remediation_preview.get("records", [])
    structural_remediation_preview_screens = [
        _preview_load_screen_record(record)
        for record in structural_remediation_preview_records
        if record.get("reload_ok")
    ]
    structural_remediation_thinness_impact = [
        _preview_thinness_impact_record(record)
        for record in structural_remediation_preview_records
        if record.get("reload_ok")
    ]
    structural_remediation_internal_cavity_impact = [
        _preview_internal_cavity_impact_record(
            record,
            generated_records_by_link=generated_records_by_link,
        )
        for record in structural_remediation_preview_records
        if record.get("reload_ok")
    ]
    accepted_remediation_preview_screens = [
        record for record in structural_remediation_preview_screens if record["accepted"]
    ]
    remediation_preview_screen_safety_factors = [
        float(record["minimum_safety_factor"])
        for record in structural_remediation_preview_screens
        if record.get("minimum_safety_factor") is not None
    ]
    remediation_internal_cavity_minimum_clearances = [
        float(record["adjusted_minimum_projected_clearance_m"])
        for record in structural_remediation_internal_cavity_impact
        if record.get("adjusted_minimum_projected_clearance_m") is not None
    ]
    finite_deflections = [
        float(record["max_deflection_m"])
        for record in link_records
        if record.get("max_deflection_m") is not None
    ]
    topology_repair_records = [
        record for record in link_records if record["topology_repair_preview_available"]
    ]
    group_records = []
    for group in body_groups:
        links = {str(link) for link in group.get("links", [])}
        records = [record for record in link_records if record["part_id"] in links]
        thinness_records = [
            record
            for record in structural_remediation_thinness_impact
            if record["link"] in links
        ]
        current_xy_area = sum(float(record["current_xy_area_m2"]) for record in thinness_records)
        adjusted_xy_area = sum(float(record["adjusted_xy_area_m2"]) for record in thinness_records)
        group_records.append(
            {
                "group": group["group"],
                "part_count": len(records),
                "wall_thickness_failures": sum(
                    1 for record in records if not record["wall_thickness_ok"]
                ),
                "manufacturing_adjusted_wall_thickness_failures": sum(
                    1
                    for record in records
                    if not record["manufacturing_adjusted_wall_thickness_ok"]
                ),
                "internal_cavity_blockers": sum(
                    1 for record in records if int(record["internal_cavity_violation_count"]) > 0
                ),
                "volume_adjusted_blockers": sum(
                    1 for record in records if int(record["volume_adjusted_violation_count"]) > 0
                ),
                "ribbed_preview_required_links": [
                    record["part_id"] for record in records if record["ribbed_preview_required"]
                ],
                "analytic_load_case_failure_links": [
                    record["part_id"]
                    for record in records
                    if any(not case.get("accepted") for case in record.get("load_cases", []))
                ],
                "structural_remediation_links": [
                    record["part_id"] for record in records if record.get("structural_remediation")
                ],
                "structural_remediation_current_xy_area_m2": current_xy_area,
                "structural_remediation_adjusted_xy_area_m2": adjusted_xy_area,
                "structural_remediation_xy_area_increase_fraction": (
                    (adjusted_xy_area - current_xy_area) / current_xy_area
                    if current_xy_area > 0.0
                    else None
                ),
                "topology_repair_preview_links": [
                    record["part_id"]
                    for record in records
                    if record["topology_repair_preview_available"]
                ],
                "accepted": False,
            }
        )
    ribbed_summary = generated.get("summary", {})
    remediation_current_xy_area = sum(
        float(record["current_xy_area_m2"])
        for record in structural_remediation_thinness_impact
    )
    remediation_adjusted_xy_area = sum(
        float(record["adjusted_xy_area_m2"])
        for record in structural_remediation_thinness_impact
    )
    return {
        "schema": STRUCTURAL_SCHEMA,
        "ok": bool(generated.get("ok") and len(link_records) == 28),
        "accepted": False,
        "summary": {
            "links": len(link_records),
            "wall_thickness_failures": len(wall_failures),
            "manufacturing_adjusted_wall_thickness_failures": len(adjusted_wall_failures),
            "manufacturing_adjusted_plate_exports": int(
                ribbed_summary.get("manufacturing_adjusted_plate_exports") or 0
            ),
            "manufacturing_adjusted_plate_max_thickness_increase_m": float(
                ribbed_summary.get("manufacturing_adjusted_plate_max_thickness_increase_m")
                or 0.0
            ),
            "manufacturing_adjusted_plate_max_height_delta_m": float(
                ribbed_summary.get("manufacturing_adjusted_plate_max_height_delta_m") or 0.0
            ),
            "internal_cavity_blocker_links": len(cavity_blockers),
            "volume_adjusted_blocker_links": len(volume_blockers),
            "ribbed_bulged_preview_candidates": int(
                ribbed_summary.get("ribbed_bulged_preview_candidates") or 0
            ),
            "ribbed_bulged_preview_residual_structural_risk_links": int(
                ribbed_summary.get("ribbed_bulged_preview_residual_structural_risk_links")
                or 0
            ),
            "topology_repair_preview_links": len(topology_repair_records),
            "topology_repair_preview_envelope_preserved_links": sum(
                1
                for record in topology_repair_records
                if record["topology_repair_preview_envelope_preserved"]
            ),
            "topology_repair_preview_height_preserved_links": sum(
                1
                for record in topology_repair_records
                if record["topology_repair_preview_height_preserved"]
            ),
            "topology_repair_preview_max_abs_volume_delta_fraction": max(
                (
                    abs(float(record["topology_repair_preview_volume_delta_fraction"]))
                    for record in topology_repair_records
                    if record["topology_repair_preview_volume_delta_fraction"] is not None
                ),
                default=None,
            ),
            "analytic_load_cases": len(analytic_load_cases),
            "analytic_load_case_failures": len(failed_analytic_load_cases),
            "analytic_load_case_failure_links": len(analytic_failure_links),
            "analytic_load_case_top_failure_links": analytic_failure_links[:8],
            "structural_remediation_links": len(structural_remediation_plan),
            "structural_remediation_top_links": [
                record["link"] for record in structural_remediation_plan[:8]
            ],
            "structural_remediation_max_minor_axis_increase_m": max(
                (
                    float(record["minor_axis_increase_m"])
                    for record in structural_remediation_plan
                ),
                default=0.0,
            ),
            "structural_remediation_max_required_minor_axis_m": max(
                (
                    float(record["required_square_minor_axis_m"])
                    for record in structural_remediation_plan
                ),
                default=0.0,
            ),
            "structural_remediation_safety_factor_target": (
                DEFAULT_STRUCTURAL_REMEDIATION_SAFETY_FACTOR_TARGET
            ),
            "structural_remediation_preview_exports": sum(
                1 for record in structural_remediation_preview_records if record["export_ok"]
            ),
            "structural_remediation_preview_reloads": sum(
                1 for record in structural_remediation_preview_records if record["reload_ok"]
            ),
            "structural_remediation_preview_failures": len(
                structural_remediation_preview.get("failures", [])
            ),
            "structural_remediation_preview_height_preserved_links": sum(
                1 for record in structural_remediation_preview_records if record["height_preserved"]
            ),
            "structural_remediation_preview_center_preserved_links": sum(
                1 for record in structural_remediation_preview_records if record["center_preserved"]
            ),
            "structural_remediation_preview_single_solid_links": sum(
                1 for record in structural_remediation_preview_records if record["solid_count_ok"]
            ),
            "structural_remediation_preview_screened_links": len(
                structural_remediation_preview_screens
            ),
            "structural_remediation_preview_screen_pass_links": len(
                accepted_remediation_preview_screens
            ),
            "structural_remediation_preview_min_safety_factor": min(
                remediation_preview_screen_safety_factors,
                default=None,
            ),
            "structural_remediation_preview_xy_area_increase_m2": (
                remediation_adjusted_xy_area - remediation_current_xy_area
            ),
            "structural_remediation_preview_xy_area_increase_fraction": (
                (remediation_adjusted_xy_area - remediation_current_xy_area)
                / remediation_current_xy_area
                if remediation_current_xy_area > 0.0
                else None
            ),
            "structural_remediation_preview_max_xy_area_increase_fraction": max(
                (
                    float(record["xy_area_increase_fraction"])
                    for record in structural_remediation_thinness_impact
                    if record["xy_area_increase_fraction"] is not None
                ),
                default=None,
            ),
            "structural_remediation_preview_max_minor_axis_increase_m": max(
                (
                    float(record["max_minor_axis_increase_m"])
                    for record in structural_remediation_thinness_impact
                ),
                default=0.0,
            ),
            "structural_remediation_internal_cavity_checked_links": len(
                structural_remediation_internal_cavity_impact
            ),
            "structural_remediation_internal_cavity_improved_links": sum(
                1
                for record in structural_remediation_internal_cavity_impact
                if record["improves_internal_cavity"]
            ),
            "structural_remediation_internal_cavity_cleared_links": sum(
                1
                for record in structural_remediation_internal_cavity_impact
                if record["clears_internal_cavity"]
            ),
            "structural_remediation_internal_cavity_residual_violation_links": sum(
                1
                for record in structural_remediation_internal_cavity_impact
                if int(record["adjusted_violation_count"]) > 0
            ),
            "structural_remediation_internal_cavity_current_violations": sum(
                int(record["current_violation_count"])
                for record in structural_remediation_internal_cavity_impact
            ),
            "structural_remediation_internal_cavity_adjusted_violations": sum(
                int(record["adjusted_violation_count"])
                for record in structural_remediation_internal_cavity_impact
            ),
            "structural_remediation_internal_cavity_z_blocked_links": sum(
                1
                for record in structural_remediation_internal_cavity_impact
                if record["requires_z_pocket_or_component_refinement"]
            ),
            "structural_remediation_internal_cavity_minimum_projected_clearance_m": min(
                remediation_internal_cavity_minimum_clearances,
                default=None,
            ),
            "max_preliminary_deflection_m": max(finite_deflections, default=None),
            "minimum_preliminary_safety_factor": min(finite_safety_factors, default=None),
            "nominal_load_n": DEFAULT_NOMINAL_LOAD_N,
            "structural_sanity_accepted": False,
            "acceptance_blocker": (
                "generated CAD has preliminary section/wall/rib evidence only; "
                "it still lacks exact load cases, fastener edge-distance checks, "
                "buckling/deflection analysis, and FEA-equivalent verification"
            ),
        },
        "structural_remediation_plan": structural_remediation_plan,
        "structural_remediation_preview": structural_remediation_preview,
        "structural_remediation_preview_screen": structural_remediation_preview_screens,
        "structural_remediation_thinness_impact": structural_remediation_thinness_impact,
        "structural_remediation_internal_cavity_impact": (
            structural_remediation_internal_cavity_impact
        ),
        "body_groups": group_records,
        "parts": link_records,
    }


def dump_fembot_structural_sanity_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_structural_sanity_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-structural-sanity.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_structural_sanity_proof_json(report), encoding="utf-8")
    return output
