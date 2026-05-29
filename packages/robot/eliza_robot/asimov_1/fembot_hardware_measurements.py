"""Hardware measurement requirements for ASIMOV fembot production constraints."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF, ASIMOV1_SOURCE_MESH_DIR
from eliza_robot.asimov_1.fembot_component_constraints import (
    build_fembot_component_constraint_coverage_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

HARDWARE_MEASUREMENT_SCHEMA = "asimov-fembot-hardware-measurement-requirements-v1"
HARDWARE_MEASUREMENT_TEMPLATE_SCHEMA = "asimov-fembot-hardware-measurement-template-v1"
HARDWARE_MEASUREMENT_EVIDENCE_SCHEMA = "asimov-fembot-hardware-measurement-evidence-v1"
ALLOWED_EVIDENCE_SOURCE_TYPES = {
    "cad_inspection",
    "caliper",
    "datasheet",
    "inertia_fixture",
    "scale",
    "test_fixture",
    "vendor_drawing",
}


MEASUREMENT_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "motor_actuator": (
        "motor_body_diameter_m",
        "motor_body_length_m",
        "output_shaft_diameter_m",
        "mounting_pattern_xyz_m",
        "connector_keepout_envelope_xyz_m",
    ),
    "bearing_or_ring": (
        "bore_diameter_m",
        "outer_diameter_m",
        "axial_width_m",
        "seat_tolerance_m",
        "retention_feature_clearance_m",
    ),
    "gear_or_pulley_or_belt": (
        "transmission_type_or_direct_drive_evidence",
        "pitch_or_pulley_diameter_m",
        "tooth_or_belt_width_m",
        "swept_path_envelope_xyz_m",
    ),
    "fastener_or_thread": (
        "fastener_diameter_m",
        "thread_pitch_m",
        "minimum_edge_distance_m",
        "tool_access_envelope_xyz_m",
        "insert_or_nut_trap_envelope_xyz_m",
    ),
    "wiring_or_service_access": (
        "wire_bundle_diameter_m",
        "minimum_bend_radius_m",
        "connector_envelope_xyz_m",
        "service_clearance_envelope_xyz_m",
    ),
    "vendor_off_the_shelf": (
        "vendor_part_number",
        "component_family",
        "datasheet_or_measured_envelope_xyz_m",
        "mounting_pattern_xyz_m",
    ),
    "component_specific_clearance": (
        "exact_component_envelope_xyz_m",
        "required_local_relief_radius_m",
        "verified_clearance_after_relief_m",
    ),
    "mass_inertia_calibration": (
        "measured_link_mass_kg",
        "measured_center_of_mass_xyz_m",
        "measured_diagonal_inertia_kg_m2",
        "mass_inertia_measurement_fixture_or_method",
    ),
}


def _family_record(report: dict[str, Any], family: str) -> dict[str, Any]:
    for record in report.get("component_families", []):
        if record.get("family") == family:
            return record
    return {}


def _covered_links(report: dict[str, Any], family: str) -> set[str]:
    return {str(link).upper() for link in _family_record(report, family).get("covered_links", [])}


def _link_steps(generated_cad_report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link")).upper(): record
        for record in generated_cad_report.get("link_steps", [])
        if isinstance(record, dict)
    }


def _add_requirements(
    requirements: list[dict[str, Any]],
    *,
    family: str,
    source: str,
    required_fields: tuple[str, ...] | None = None,
    target: dict[str, Any] | None = None,
) -> None:
    fields = required_fields or MEASUREMENT_REQUIREMENTS[family]
    for field in fields:
        requirements.append(
            {
                "family": family,
                "field": field,
                "source": source,
                "status": "missing",
                "target_id": target.get("target_id") if target else None,
                "component_type": target.get("component_type") if target else None,
                "component_name": target.get("name") if target else None,
                "required_local_pocket_radius_m": target.get("required_local_pocket_radius_m")
                if target
                else None,
            }
        )


def _measurement_key(
    *,
    link: str,
    family: str,
    field: str,
    target_id: str | None,
) -> str:
    target = target_id or "link"
    return f"{link}:{family}:{field}:{target}"


def _expected_unit(field: str) -> str:
    if field.endswith("_xyz_m"):
        return "m_triplet"
    if field.endswith("_kg"):
        return "kg"
    if field.endswith("_kg_m2"):
        return "kg_m2_triplet"
    if field.endswith("_m") or field in {
        "bore_diameter_m",
        "outer_diameter_m",
        "axial_width_m",
        "seat_tolerance_m",
        "thread_pitch_m",
    }:
        return "m"
    if field in {
        "vendor_part_number",
        "component_family",
        "transmission_type_or_direct_drive_evidence",
        "datasheet_or_measured_envelope_xyz_m",
    }:
        return "text"
    return "text_or_m"


def _count_by_key(records: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in records:
        value = str(record.get(key))
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items()))


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, int | float) and value == value and value not in {
        float("inf"),
        float("-inf"),
    }


def _has_supplied_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _is_number_triplet(value: Any) -> bool:
    return (
        isinstance(value, list | tuple)
        and len(value) == 3
        and all(_is_finite_number(item) for item in value)
    )


def _measurement_value_error(value: Any, expected_unit: str) -> str | None:
    if expected_unit == "m":
        if not _is_finite_number(value) or float(value) <= 0.0:
            return "expected a positive finite meter value"
    elif expected_unit == "kg":
        if not _is_finite_number(value) or float(value) <= 0.0:
            return "expected a positive finite kilogram value"
    elif expected_unit == "m_triplet":
        if not _is_number_triplet(value):
            return "expected a 3-item finite meter triplet"
    elif expected_unit == "kg_m2_triplet":
        if not _is_number_triplet(value) or any(float(item) <= 0.0 for item in value):
            return "expected a 3-item positive finite kg*m^2 inertia triplet"
    elif expected_unit == "text":
        if not isinstance(value, str) or not value.strip():
            return "expected a non-empty text value"
    elif expected_unit == "text_or_m" and (
        isinstance(value, str)
        and not value.strip()
        or not isinstance(value, str)
        and (not _is_finite_number(value) or float(value) <= 0.0)
    ):
        return "expected non-empty text or a positive finite meter value"
    return None


def _measurement_source_error(row: dict[str, Any]) -> str | None:
    source = row.get("source")
    source_type = row.get("source_type")
    if not isinstance(source, str) or not source.strip():
        return "expected a non-empty source reference"
    if source_type not in ALLOWED_EVIDENCE_SOURCE_TYPES:
        return (
            "expected source_type to be one of "
            f"{', '.join(sorted(ALLOWED_EVIDENCE_SOURCE_TYPES))}"
        )
    return None


def build_fembot_hardware_measurement_template(
    measurement_report: dict[str, Any],
) -> dict[str, Any]:
    """Return a deterministic input template for required hardware dimensions."""
    rows: list[dict[str, Any]] = []
    for link_record in measurement_report.get("links", []):
        link = str(link_record.get("link", "")).upper()
        group = str(link_record.get("group", ""))
        for requirement in link_record.get("requirements", []):
            family = str(requirement.get("family"))
            field = str(requirement.get("field"))
            target_id = requirement.get("target_id")
            rows.append(
                {
                    "measurement_key": _measurement_key(
                        link=link,
                        family=family,
                        field=field,
                        target_id=str(target_id) if target_id else None,
                    ),
                    "group": group,
                    "link": link,
                    "family": family,
                    "field": field,
                    "expected_unit": _expected_unit(field),
                    "value": None,
                    "source": None,
                    "source_type": None,
                    "status": "empty",
                    "target_id": target_id,
                    "component_type": requirement.get("component_type"),
                    "component_name": requirement.get("component_name"),
                    "required_local_pocket_radius_m": requirement.get(
                        "required_local_pocket_radius_m"
                    ),
                    "requirement_source": requirement.get("source"),
                }
            )
    return {
        "schema": HARDWARE_MEASUREMENT_TEMPLATE_SCHEMA,
        "accepted": False,
        "summary": {
            "rows": len(rows),
            "links": len({row["link"] for row in rows}),
            "families": _count_by_key(rows, "family"),
            "filled_rows": 0,
            "missing_rows": len(rows),
            "accepted": False,
        },
        "measurements": rows,
    }


def validate_fembot_hardware_measurement_evidence(
    measurement_report: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Validate filled hardware measurement evidence against the template keys."""
    template = build_fembot_hardware_measurement_template(measurement_report)
    expected = {row["measurement_key"]: row for row in template["measurements"]}
    evidence_rows = evidence.get("measurements", [])
    supplied: dict[str, dict[str, Any]] = {}
    duplicate_keys: list[str] = []
    malformed_rows = []
    for row in evidence_rows:
        if not isinstance(row, dict):
            malformed_rows.append({"row": row, "reason": "measurement row is not an object"})
            continue
        key = row.get("measurement_key")
        if not key:
            malformed_rows.append({"row": row, "reason": "missing measurement_key"})
            continue
        key = str(key)
        if key in supplied:
            duplicate_keys.append(key)
        supplied[key] = row

    unknown_keys = sorted(key for key in supplied if key not in expected)
    valid_filled_keys = []
    unit_mismatches = []
    invalid_measurements = []
    provenance_errors = []
    for key, row in supplied.items():
        if key not in expected:
            continue
        if not _has_supplied_value(row.get("value")):
            continue
        expected_unit = expected[key]["expected_unit"]
        supplied_unit = supplied[key].get("unit")
        if supplied_unit != expected_unit:
            unit_mismatches.append(
                {
                    "measurement_key": key,
                    "expected_unit": expected_unit,
                    "supplied_unit": supplied_unit,
                }
            )
            continue
        source_error = _measurement_source_error(row)
        if source_error:
            provenance_errors.append(
                {
                    "measurement_key": key,
                    "reason": source_error,
                }
            )
            continue
        value_error = _measurement_value_error(row.get("value"), expected_unit)
        if value_error:
            invalid_measurements.append(
                {
                    "measurement_key": key,
                    "expected_unit": expected_unit,
                    "reason": value_error,
                }
            )
            continue
        valid_filled_keys.append(key)
    valid_filled_keys = sorted(valid_filled_keys)
    missing_keys = sorted(key for key in expected if key not in valid_filled_keys)
    accepted = bool(
        expected
        and not missing_keys
        and not unknown_keys
        and not duplicate_keys
        and not malformed_rows
        and not unit_mismatches
        and not invalid_measurements
        and not provenance_errors
    )
    return {
        "schema": HARDWARE_MEASUREMENT_EVIDENCE_SCHEMA,
        "ok": True,
        "accepted": accepted,
        "summary": {
            "required_measurements": len(expected),
            "supplied_measurements": len(supplied),
            "filled_measurements": len(valid_filled_keys),
            "missing_measurements": len(missing_keys),
            "unknown_measurements": len(unknown_keys),
            "duplicate_measurements": len(duplicate_keys),
            "malformed_measurements": len(malformed_rows),
            "unit_mismatches": len(unit_mismatches),
            "invalid_measurements": len(invalid_measurements),
            "provenance_errors": len(provenance_errors),
            "accepted": accepted,
        },
        "missing_keys": missing_keys,
        "unknown_keys": unknown_keys,
        "duplicate_keys": sorted(set(duplicate_keys)),
        "malformed_rows": malformed_rows,
        "unit_mismatches": unit_mismatches,
        "invalid_measurements": invalid_measurements,
        "provenance_errors": provenance_errors,
    }


def apply_fembot_hardware_measurement_evidence(
    measurement_report: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Return a hardware measurement proof annotated with accepted evidence status."""
    validation = validate_fembot_hardware_measurement_evidence(measurement_report, evidence)
    supplied = {
        str(row.get("measurement_key")): row
        for row in evidence.get("measurements", [])
        if isinstance(row, dict) and row.get("measurement_key")
    }
    accepted_keys = set(validation.get("missing_keys", []))
    all_keys = {
        row["measurement_key"]
        for row in build_fembot_hardware_measurement_template(measurement_report)[
            "measurements"
        ]
    }
    accepted_keys = all_keys - accepted_keys
    report = deepcopy(measurement_report)
    report["evidence_validation"] = validation
    for link_record in report.get("links", []):
        link = str(link_record.get("link", "")).upper()
        accepted_count = 0
        missing_count = 0
        for requirement in link_record.get("requirements", []):
            key = _measurement_key(
                link=link,
                family=str(requirement.get("family")),
                field=str(requirement.get("field")),
                target_id=(
                    str(requirement.get("target_id"))
                    if requirement.get("target_id")
                    else None
                ),
            )
            if key in accepted_keys and key in supplied:
                row = supplied[key]
                requirement["status"] = "accepted"
                requirement["value"] = row.get("value")
                requirement["unit"] = row.get("unit")
                requirement["source"] = row.get("source")
                requirement["source_type"] = row.get("source_type")
                accepted_count += 1
            else:
                requirement["status"] = "missing"
                missing_count += 1
        link_record["accepted_measurement_count"] = accepted_count
        link_record["missing_measurement_count"] = missing_count
        link_record["accepted"] = missing_count == 0 and bool(link_record.get("requirements"))

    for group_record in report.get("body_groups", []):
        links = {str(link).upper() for link in group_record.get("links", [])}
        link_records = [
            record
            for record in report.get("links", [])
            if str(record.get("link")).upper() in links
        ]
        accepted_count = sum(
            int(record.get("accepted_measurement_count", 0)) for record in link_records
        )
        missing_count = sum(
            int(record.get("missing_measurement_count", 0)) for record in link_records
        )
        group_record["accepted_measurement_count"] = accepted_count
        group_record["missing_measurement_count"] = missing_count
        group_record["accepted"] = missing_count == 0 and bool(link_records)

    summary = report.setdefault("summary", {})
    summary["accepted_measurement_records"] = validation["summary"]["filled_measurements"]
    summary["missing_measurement_records"] = validation["summary"]["missing_measurements"]
    summary["evidence_accepted"] = validation["accepted"]
    summary["accepted"] = bool(validation["accepted"])
    summary["acceptance_blocker"] = (
        None
        if validation["accepted"]
        else summary.get("acceptance_blocker")
    )
    report["accepted"] = bool(validation["accepted"])
    return report


def build_fembot_hardware_measurement_requirements_proof(
    body_groups: list[dict[str, Any]],
    *,
    component_constraint_report: dict[str, Any] | None = None,
    generated_cad_report: dict[str, Any] | None = None,
    mesh_dir: Path = ASIMOV1_SOURCE_MESH_DIR,
    mjcf_path: Path = ASIMOV1_GENERATED_MJCF,
) -> dict[str, Any]:
    """Map missing hardware families to concrete dimensions needed for CAD acceptance."""
    if component_constraint_report is None:
        component_constraint_report = build_fembot_component_constraint_coverage_proof(body_groups)
    if generated_cad_report is None:
        generated_cad_report = build_fembot_generated_cad_envelope_proof(
            body_groups,
            mesh_dir=mesh_dir,
            mjcf_path=mjcf_path,
        )

    actuator_links = _covered_links(component_constraint_report, "motor_actuator")
    joint_links = _covered_links(component_constraint_report, "joint_axis")
    vendor_links = _covered_links(component_constraint_report, "vendor_off_the_shelf")
    steps_by_link = _link_steps(generated_cad_report)
    vendor_summary = component_constraint_report.get("vendor_envelope_summary", {})

    link_records: list[dict[str, Any]] = []
    missing_links: list[str] = []
    for group in body_groups:
        group_name = str(group.get("group"))
        for link in [str(item).upper() for item in group.get("links", [])]:
            generated = steps_by_link.get(link)
            if generated is None:
                missing_links.append(link)
                generated = {}
            requirements: list[dict[str, Any]] = []
            _add_requirements(
                requirements,
                family="mass_inertia_calibration",
                source="physics_calibration_requires_measured_mass_com_and_inertia",
            )
            if link in actuator_links:
                _add_requirements(
                    requirements,
                    family="motor_actuator",
                    source="mjcf_actuator_uses_conservative_radius_only",
                )
                _add_requirements(
                    requirements,
                    family="gear_or_pulley_or_belt",
                    source="actuator_link_needs_transmission_or_direct_drive_disposition",
                )
            if link in joint_links:
                _add_requirements(
                    requirements,
                    family="bearing_or_ring",
                    source="joint_axis_needs_bearing_or_ring_seat_dimensions",
                )
            _add_requirements(
                requirements,
                family="fastener_or_thread",
                source="production_part_needs_mate_fastener_and_tool_access_definition",
            )
            if link in actuator_links or group_name in {"torso", "head"}:
                _add_requirements(
                    requirements,
                    family="wiring_or_service_access",
                    source="powered_or_serviceable_link_needs_wire_connector_access",
                )
            if link in vendor_links:
                _add_requirements(
                    requirements,
                    family="vendor_off_the_shelf",
                    source="off_the_shelf_step_envelope_needs_vendor_identity_and_datasheet",
                )
            for target in generated.get("remediation_targets", []):
                _add_requirements(
                    requirements,
                    family="component_specific_clearance",
                    source="generated_cad_internal_cavity_remediation_target",
                    target=target,
                )
            link_records.append(
                {
                    "group": group_name,
                    "link": link,
                    "actuator_link": link in actuator_links,
                    "joint_link": link in joint_links,
                    "vendor_envelope_link": link in vendor_links,
                    "surface_intent": generated.get("surface_intent"),
                    "shape_family": generated.get("shape_family"),
                    "remediation_target_count": len(generated.get("remediation_targets", [])),
                    "measurement_count": len(requirements),
                    "missing_measurement_count": len(requirements),
                    "families_required": sorted({record["family"] for record in requirements}),
                    "requirements": requirements,
                    "accepted": False,
                }
            )

    all_requirements = [
        requirement for record in link_records for requirement in record["requirements"]
    ]
    family_counts = _count_by_key(all_requirements, "family")
    group_records: list[dict[str, Any]] = []
    for group in body_groups:
        group_name = str(group.get("group"))
        records = [record for record in link_records if record["group"] == group_name]
        group_requirements = [
            requirement for record in records for requirement in record["requirements"]
        ]
        group_records.append(
            {
                "group": group_name,
                "links": [str(link).upper() for link in group.get("links", [])],
                "measurement_count": len(group_requirements),
                "missing_measurement_count": len(group_requirements),
                "family_counts": _count_by_key(group_requirements, "family"),
                "remediation_target_count": sum(
                    int(record["remediation_target_count"]) for record in records
                ),
                "accepted": False,
            }
        )

    ok = bool(
        component_constraint_report.get("ok")
        and generated_cad_report.get("ok")
        and len(link_records) == 28
        and not missing_links
    )
    return {
        "schema": HARDWARE_MEASUREMENT_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "component_constraint_schema": component_constraint_report.get("schema"),
            "generated_cad_schema": generated_cad_report.get("schema"),
            "mesh_dir": str(mesh_dir),
            "mjcf": str(mjcf_path),
        },
        "summary": {
            "links": len(link_records),
            "body_groups": len(group_records),
            "missing_links": sorted(set(missing_links)),
            "actuator_links": len(actuator_links),
            "joint_links": len(joint_links),
            "vendor_envelope_links": len(vendor_links),
            "links_with_remediation_targets": sum(
                1 for record in link_records if record["remediation_target_count"] > 0
            ),
            "remediation_targets": sum(
                int(record["remediation_target_count"]) for record in link_records
            ),
            "measurement_records": len(all_requirements),
            "missing_measurement_records": len(all_requirements),
            "family_counts": family_counts,
            "vendor_envelopes_with_supplier_codes": vendor_summary.get(
                "vendor_envelopes_with_supplier_codes",
                0,
            ),
            "vendor_envelopes_with_component_family_keywords": vendor_summary.get(
                "vendor_envelopes_with_component_family_keywords",
                0,
            ),
            "accepted": False,
            "acceptance_blocker": (
                "the fembot CAD stack has conservative keepouts and remediation pockets, "
                "but exact motor packages, bearing/ring seats, transmission disposition, "
                "fasteners, wiring/service access, vendor identities, and per-target "
                "component envelopes are still missing"
            ),
        },
        "body_groups": group_records,
        "links": link_records,
    }


def dump_fembot_hardware_measurement_requirements_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def dump_fembot_hardware_measurement_template_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def dump_fembot_hardware_measurement_evidence_validation_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_hardware_measurement_requirements_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-hardware-measurements.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_hardware_measurement_requirements_proof_json(report),
        encoding="utf-8",
    )
    return output


def write_fembot_hardware_measurement_template(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-hardware-measurement-template.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_hardware_measurement_template_json(report),
        encoding="utf-8",
    )
    return output


def write_fembot_hardware_measurement_evidence_validation(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-hardware-measurement-validation.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_hardware_measurement_evidence_validation_json(report),
        encoding="utf-8",
    )
    return output
