"""Mass and inertia reconciliation plan for ASIMOV fembot generated CAD."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_inertia_calibration import (
    INERTIA_RELATIVE_DELTA_TOLERANCE,
    MASS_RELATIVE_DELTA_TOLERANCE,
    build_fembot_inertia_calibration_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_MASS_RECONCILIATION_SCHEMA = "asimov-fembot-mass-reconciliation-plan-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _finite_values(values: list[Any]) -> list[float]:
    finite: list[float] = []
    for value in values:
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if numeric == numeric and numeric not in {float("inf"), float("-inf")}:
            finite.append(numeric)
    return finite


def _mass_action(record: dict[str, Any]) -> str:
    scale = record.get("mass_scale_to_compiled")
    if scale is None:
        return "mass_measurement_required"
    scale = float(scale)
    if scale > 1.0 + MASS_RELATIVE_DELTA_TOLERANCE:
        return "add_internal_mass_or_retarget_material_density"
    if scale < 1.0 - MASS_RELATIVE_DELTA_TOLERANCE:
        return "reduce_shell_mass_or_retarget_compiled_body_mass"
    return "mass_within_tolerance_pending_hardware_measurement"


def _inertia_action(record: dict[str, Any]) -> str:
    if record.get("inertia_within_tolerance"):
        return "inertia_within_tolerance_pending_hardware_measurement"
    return "retarget_inertia_tensor_or_add_distributed_ballast"


def _severity(record: dict[str, Any]) -> str:
    mass_scale = record.get("mass_scale_to_compiled")
    inertia_scales = _finite_values(record.get("inertia_scale_to_compiled") or [])
    scale_error = 1.0
    if mass_scale is not None:
        mass_scale_float = float(mass_scale)
        scale_error = max(scale_error, mass_scale_float, 1.0 / max(mass_scale_float, 1.0e-12))
    if inertia_scales:
        scale_error = max(
            scale_error,
            max(max(value, 1.0 / max(value, 1.0e-12)) for value in inertia_scales),
        )
    if scale_error >= 25.0:
        return "major_reparameterization_required"
    if scale_error >= 5.0:
        return "large_mass_property_retarget_required"
    if scale_error > 1.0 + max(MASS_RELATIVE_DELTA_TOLERANCE, INERTIA_RELATIVE_DELTA_TOLERANCE):
        return "localized_mass_property_retarget_required"
    return "hardware_measurement_closure"


def _record_plan(record: dict[str, Any]) -> dict[str, Any]:
    added_mass = float(record.get("required_added_mass_to_match_compiled_kg") or 0.0)
    inertia_scales = _finite_values(record.get("inertia_scale_to_compiled") or [])
    return {
        "link": record["link"],
        "group": record.get("group"),
        "body": record.get("body"),
        "cad_material_mass_estimate_kg": record.get("cad_material_mass_estimate_kg"),
        "compiled_mass_kg": record.get("compiled_mass_kg"),
        "required_added_mass_to_match_compiled_kg": added_mass,
        "mass_scale_to_compiled": record.get("mass_scale_to_compiled"),
        "max_inertia_scale_to_compiled": max(inertia_scales, default=None),
        "mass_within_tolerance": bool(record.get("mass_within_tolerance")),
        "inertia_within_tolerance": bool(record.get("inertia_within_tolerance")),
        "hardware_measurement_present": bool(record.get("hardware_measurement_present")),
        "mass_action": _mass_action(record),
        "inertia_action": _inertia_action(record),
        "severity": _severity(record),
        "required_evidence": [
            "measured link mass with fixture/tare notes",
            "measured center of mass in link frame",
            "identified diagonal inertia or inertia tensor fit",
            "updated MJCF inertial record and CAD material/ballast provenance",
        ],
        "accepted": False,
    }


def build_fembot_mass_reconciliation_plan_proof(
    body_groups: list[dict[str, Any]],
    *,
    inertia_calibration_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    inertia = (
        inertia_calibration_report
        or build_fembot_inertia_calibration_proof(body_groups)
    )
    records = [_record_plan(record) for record in inertia.get("link_inertia_records", [])]
    action_counts: dict[str, int] = {}
    severity_counts: dict[str, int] = {}
    for record in records:
        for key in ("mass_action", "inertia_action"):
            action = str(record[key])
            action_counts[action] = action_counts.get(action, 0) + 1
        severity = str(record["severity"])
        severity_counts[severity] = severity_counts.get(severity, 0) + 1
    mass_out = [record for record in records if not record["mass_within_tolerance"]]
    inertia_out = [record for record in records if not record["inertia_within_tolerance"]]
    missing_hardware = [
        record for record in records if not record["hardware_measurement_present"]
    ]
    added_mass_records = [
        record
        for record in records
        if record["mass_action"] == "add_internal_mass_or_retarget_material_density"
    ]
    reduce_mass_records = [
        record
        for record in records
        if record["mass_action"] == "reduce_shell_mass_or_retarget_compiled_body_mass"
    ]
    ok = bool(
        inertia.get("ok")
        and len(records) == 28
        and inertia.get("summary", {}).get("missing_compiled_links") == []
        and inertia.get("summary", {}).get("missing_material_links") == []
    )
    accepted = bool(
        ok
        and not mass_out
        and not inertia_out
        and not missing_hardware
        and inertia.get("accepted")
    )
    return {
        "schema": FEMBOT_MASS_RECONCILIATION_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "inertia_calibration_schema": inertia.get("schema"),
        },
        "summary": {
            "links": len(records),
            "mass_out_of_tolerance_links": len(mass_out),
            "inertia_out_of_tolerance_links": len(inertia_out),
            "missing_hardware_measurement_links": len(missing_hardware),
            "add_internal_mass_or_density_retarget_links": len(added_mass_records),
            "reduce_shell_mass_or_compiled_mass_retarget_links": len(reduce_mass_records),
            "total_required_added_mass_to_match_compiled_kg": sum(
                float(record["required_added_mass_to_match_compiled_kg"])
                for record in records
            ),
            "max_required_added_mass_to_match_compiled_kg": max(
                (
                    float(record["required_added_mass_to_match_compiled_kg"])
                    for record in records
                ),
                default=0.0,
            ),
            "max_mass_scale_to_compiled": max(
                (
                    float(record["mass_scale_to_compiled"])
                    for record in records
                    if record.get("mass_scale_to_compiled") is not None
                ),
                default=None,
            ),
            "max_inertia_scale_to_compiled": max(
                (
                    float(record["max_inertia_scale_to_compiled"])
                    for record in records
                    if record.get("max_inertia_scale_to_compiled") is not None
                ),
                default=None,
            ),
            "action_counts": dict(sorted(action_counts.items())),
            "severity_counts": dict(sorted(severity_counts.items())),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "generated CAD/material mass properties are mapped to compiled "
                "MuJoCo inertias, but link masses/inertias still need hardware "
                "measurement plus CAD material, ballast, or MJCF inertial retargeting"
            ),
        },
        "links": records,
    }


def dump_fembot_mass_reconciliation_plan_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mass_reconciliation_plan_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mass-reconciliation-plan.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_mass_reconciliation_plan_proof_json(report),
        encoding="utf-8",
    )
    return output
