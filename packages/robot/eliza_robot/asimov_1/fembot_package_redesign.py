"""Component/package redesign plan for height-preserving ASIMOV fembot links."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_cavity_resolution import (
    build_fembot_cavity_resolution_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_PACKAGE_REDESIGN_SCHEMA = "asimov-fembot-package-redesign-plan-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _action_plan(record: dict[str, Any]) -> list[dict[str, Any]]:
    components = record.get("internal_cavity_violation_component_counts") or {}
    limiters = set(record.get("active_thinness_limiters") or [])
    actions: list[dict[str, Any]] = []
    if components.get("motor_actuator"):
        actions.append(
            {
                "action": "actuator_package_redesign",
                "reason": "motor actuator envelope pierces the height-preserving source-fitted loft",
                "required_evidence": (
                    "datasheet-backed motor stack, gearbox envelope, cable exit, "
                    "mount pattern, and thermal/service clearance"
                ),
            }
        )
    if components.get("joint_axis"):
        actions.append(
            {
                "action": "joint_bearing_stack_redesign",
                "reason": "joint axis or bearing/ring stack cannot clear inside the current link height",
                "required_evidence": (
                    "bearing/ring OD and width, shaft axis tolerance, fastener edge "
                    "distance, and rotation-limit collision sweep"
                ),
            }
        )
    if components.get("collision_keepout"):
        actions.append(
            {
                "action": "collision_keepout_refit_or_local_shell_relief",
                "reason": "collision keepout volume requires either a verified smaller collider or local shell relief",
                "required_evidence": (
                    "source mesh coverage comparison, contact-clean MuJoCo sweep, "
                    "and structural wall-thickness check around the relief"
                ),
            }
        )
    if components.get("site"):
        actions.append(
            {
                "action": "sensor_site_relocation_or_reserved_boss",
                "reason": "site marker placement conflicts with the thinned torso origin envelope",
                "required_evidence": (
                    "sensor board dimensions, mounting boss, cable clearance, and "
                    "updated frame transform"
                ),
            }
        )
    if record.get("supplier_vendor_limited") or "supplier_vendor_keepout" in limiters:
        actions.append(
            {
                "action": "supplier_vendor_pocket_qualification",
                "reason": "off-the-shelf vendor envelope is an active thinness limiter and cannot be scaled",
                "required_evidence": (
                    "vendor part number, measured pocket STEP, keepout orientation, "
                    "mounting pattern, and no-scale acceptance"
                ),
            }
        )
    if "manufacturing_process_floor" in limiters:
        actions.append(
            {
                "action": "manufacturing_floor_review",
                "reason": "minimum wall, web, or process-floor geometry is active at the current target",
                "required_evidence": (
                    "process-specific minimum wall/web table, draft/access check, "
                    "and adjusted STEP reload proof"
                ),
            }
        )
    z_expansion = float(record.get("full_cavity_z_expansion_m") or 0.0)
    xy_increase = float(record.get("full_cavity_xy_area_increase_fraction") or 0.0)
    if z_expansion > 0.0:
        actions.append(
            {
                "action": "z_stack_reduction_required",
                "reason": "full cavity clearance only succeeds by increasing link height",
                "required_delta_m": z_expansion,
            }
        )
    if xy_increase > 0.05:
        actions.append(
            {
                "action": "xy_envelope_tradeoff_required",
                "reason": "full cavity clearance needs a large XY footprint increase",
                "required_area_increase_fraction": xy_increase,
            }
        )
    return actions


def _severity(record: dict[str, Any]) -> str:
    z_expansion = float(record.get("full_cavity_z_expansion_m") or 0.0)
    xy_increase = float(record.get("full_cavity_xy_area_increase_fraction") or 0.0)
    if z_expansion >= 0.025 or xy_increase >= 0.25:
        return "major_package_redesign"
    if z_expansion > 0.0 or xy_increase > 0.0:
        return "localized_package_redesign"
    return "evidence_closure"


def _redesign_record(record: dict[str, Any]) -> dict[str, Any]:
    actions = _action_plan(record)
    return {
        "link": record["link"],
        "group": record.get("group"),
        "source_fitted": bool(record.get("source_fitted")),
        "severity": _severity(record),
        "component_counts": record.get("internal_cavity_violation_component_counts") or {},
        "active_thinness_limiters": record.get("active_thinness_limiters") or [],
        "supplier_vendor_limited": bool(record.get("supplier_vendor_limited")),
        "full_cavity_z_expansion_m": record.get("full_cavity_z_expansion_m"),
        "full_cavity_xy_area_increase_fraction": record.get(
            "full_cavity_xy_area_increase_fraction"
        ),
        "actions": actions,
        "action_count": len(actions),
        "height_preservation_blocker": True,
        "accepted": False,
    }


def build_fembot_package_redesign_plan_proof(
    body_groups: list[dict[str, Any]],
    *,
    cavity_resolution_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cavity = (
        cavity_resolution_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-cavity-resolution.json")
        or build_fembot_cavity_resolution_proof(body_groups)
    )
    records = [
        _redesign_record(record)
        for record in cavity.get("links", [])
        if record.get("requires_component_or_packaging_redesign")
    ]
    action_counts: dict[str, int] = {}
    severity_counts: dict[str, int] = {}
    for record in records:
        severity = str(record["severity"])
        severity_counts[severity] = severity_counts.get(severity, 0) + 1
        for action in record["actions"]:
            name = str(action["action"])
            action_counts[name] = action_counts.get(name, 0) + 1
    max_z = max(
        (float(record.get("full_cavity_z_expansion_m") or 0.0) for record in records),
        default=0.0,
    )
    max_xy = max(
        (
            float(record.get("full_cavity_xy_area_increase_fraction") or 0.0)
            for record in records
        ),
        default=0.0,
    )
    requested_link_count = len(
        {
            str(link).upper()
            for group in body_groups
            for link in group.get("links", [])
        }
    )
    ok = bool(
        cavity.get("ok")
        and requested_link_count == 28
        and cavity.get("summary", {}).get("component_or_packaging_redesign_required_links")
        == len(records)
        and len(records) == 16
        and all(record["source_fitted"] for record in records)
        and all(record["actions"] for record in records)
    )
    return {
        "schema": FEMBOT_PACKAGE_REDESIGN_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "cavity_resolution_schema": cavity.get("schema"),
        },
        "summary": {
            "links": requested_link_count,
            "component_or_packaging_redesign_required_links": len(records),
            "component_or_packaging_redesign_required_link_names": [
                record["link"] for record in records
            ],
            "height_preserving_resolution_links": cavity.get("summary", {}).get(
                "height_preserving_resolution_links"
            ),
            "major_package_redesign_links": severity_counts.get(
                "major_package_redesign", 0
            ),
            "localized_package_redesign_links": severity_counts.get(
                "localized_package_redesign", 0
            ),
            "evidence_closure_links": severity_counts.get("evidence_closure", 0),
            "max_required_z_stack_reduction_m": max_z,
            "max_required_xy_area_tradeoff_fraction": max_xy,
            "action_counts": dict(sorted(action_counts.items())),
            "accepted": False,
            "acceptance_blocker": (
                "height-preserving thinness cannot be accepted until the listed "
                "actuator, joint, collision, sensor, supplier, and manufacturing "
                "package actions have measured CAD/datasheet evidence"
            ),
        },
        "redesign_links": records,
    }


def dump_fembot_package_redesign_plan_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_package_redesign_plan_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-package-redesign-plan.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_package_redesign_plan_proof_json(report),
        encoding="utf-8",
    )
    return output
