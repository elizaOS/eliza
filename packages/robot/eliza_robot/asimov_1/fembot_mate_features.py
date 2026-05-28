"""Production mate-feature validation plan for ASIMOV fembot links."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_assembly import build_fembot_assembly_proof
from eliza_robot.asimov_1.fembot_hardware_measurements import (
    build_fembot_hardware_measurement_requirements_proof,
)
from eliza_robot.asimov_1.fembot_supplier_pocket_plan import (
    build_fembot_supplier_pocket_plan_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_MATE_FEATURES_SCHEMA = "asimov-fembot-mate-features-plan-v1"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _body_by_link(assembly: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link")).upper(): record
        for record in assembly.get("mjcf_bodies", [])
        if isinstance(record, dict) and record.get("link")
    }


def _children_by_parent(assembly: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    children: dict[str, list[dict[str, Any]]] = {}
    for record in assembly.get("mjcf_bodies", []):
        parent = record.get("parent")
        if parent:
            children.setdefault(str(parent), []).append(record)
    return children


def _joints_by_body(assembly: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    joints: dict[str, list[dict[str, Any]]] = {}
    for record in assembly.get("mjcf_joints", []):
        body = str(record.get("body") or "")
        if body:
            joints.setdefault(body, []).append(record)
    return joints


def _actuated_joints(assembly: dict[str, Any]) -> set[str]:
    return {
        str(record.get("joint"))
        for record in assembly.get("mjcf_actuators", [])
        if record.get("joint")
    }


def _hardware_by_link(hardware: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(record.get("link")).upper(): record
        for record in hardware.get("links", [])
        if isinstance(record, dict) and record.get("link")
    }


def _supplier_plans_by_link(supplier: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    plans: dict[str, list[dict[str, Any]]] = {}
    for record in supplier.get("pocket_plans", []):
        link = str(record.get("link") or "").upper()
        if link:
            plans.setdefault(link, []).append(record)
    return plans


def _requirements_for_link(
    *,
    joint_records: list[dict[str, Any]],
    child_links: list[str],
    hardware: dict[str, Any] | None,
    supplier_plans: list[dict[str, Any]],
) -> list[str]:
    requirements = ["parent_body_transform"]
    if child_links:
        requirements.append("child_mate_transform")
    if joint_records:
        requirements.extend(
            [
                "joint_axis_vector",
                "bearing_or_ring_seat",
                "bore_diameter",
                "retention_feature_clearance",
            ]
        )
    if hardware and hardware.get("actuator_link"):
        requirements.extend(["motor_mount_pattern", "gear_or_pulley_alignment"])
    if supplier_plans:
        requirements.extend(["supplier_pocket_mate_faces", "fastener_tool_access"])
    return sorted(set(requirements))


def _record_plan(
    *,
    link: str,
    group: str | None,
    body: dict[str, Any] | None,
    children: list[dict[str, Any]],
    joints: list[dict[str, Any]],
    actuated_joint_names: set[str],
    hardware: dict[str, Any] | None,
    supplier_plans: list[dict[str, Any]],
) -> dict[str, Any]:
    child_links = [str(record.get("link")) for record in children if record.get("link")]
    joint_names = [str(record.get("name")) for record in joints if record.get("name")]
    actuated_joints = [name for name in joint_names if name in actuated_joint_names]
    requirements = _requirements_for_link(
        joint_records=joints,
        child_links=child_links,
        hardware=hardware,
        supplier_plans=supplier_plans,
    )
    measurement_families = set((hardware or {}).get("families_required") or [])
    exact_bore_ready = bool(
        hardware
        and hardware.get("accepted")
        and {"bearing_or_ring", "fastener_or_thread"}.issubset(measurement_families)
    )
    supplier_proxy_ready = bool(
        supplier_plans and all(plan.get("mate_feature_assignment") for plan in supplier_plans)
    )
    supplier_exact_ready = bool(
        supplier_plans
        and all(
            plan.get("placement_transform_accepted")
            and plan.get("fastener_access_verified")
            and plan.get("collision_validation_at_placed_pocket")
            and plan.get("structural_validation_at_placed_pocket")
            for plan in supplier_plans
        )
    )
    return {
        "link": link,
        "group": group,
        "body": body.get("body") if body else None,
        "parent_body": body.get("parent") if body else None,
        "child_links": child_links,
        "joint_names": joint_names,
        "joint_axes": [record.get("axis") for record in joints],
        "actuated_joint_names": actuated_joints,
        "required_mate_features": requirements,
        "required_mate_feature_count": len(requirements),
        "hardware_measurement_count": (hardware or {}).get("measurement_count"),
        "hardware_missing_measurement_count": (hardware or {}).get(
            "missing_measurement_count"
        ),
        "exact_bore_fastener_measurements_ready": exact_bore_ready,
        "supplier_pocket_plan_count": len(supplier_plans),
        "supplier_mate_feature_proxy_ready": supplier_proxy_ready,
        "supplier_exact_placement_ready": supplier_exact_ready,
        "kinematic_proxy_ready": bool(body and (joints or child_links or body.get("parent"))),
        "accepted": False,
        "blocking_reason": (
            "MJCF kinematic proxy and generated STEP coverage are present, but "
            "production mate acceptance still needs exact bore/ring/fastener "
            "dimensions, face IDs, placement transforms, and post-placement "
            "collision/structural validation"
        ),
    }


def build_fembot_mate_features_plan_proof(
    body_groups: list[dict[str, Any]],
    *,
    assembly_report: dict[str, Any] | None = None,
    supplier_pocket_plan_report: dict[str, Any] | None = None,
    hardware_measurements_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    assembly = (
        assembly_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-assembly.json")
        or build_fembot_assembly_proof(body_groups)
    )
    supplier = (
        supplier_pocket_plan_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-supplier-pocket-plan.json")
        or build_fembot_supplier_pocket_plan_proof(body_groups)
    )
    hardware = (
        hardware_measurements_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-hardware-measurements.json")
        or build_fembot_hardware_measurement_requirements_proof(body_groups)
    )
    bodies = _body_by_link(assembly)
    children = _children_by_parent(assembly)
    joints = _joints_by_body(assembly)
    actuated = _actuated_joints(assembly)
    hardware_links = _hardware_by_link(hardware)
    supplier_links = _supplier_plans_by_link(supplier)
    requested = [
        (str(group.get("group")), str(link).upper())
        for group in body_groups
        for link in group.get("links", [])
    ]
    records = []
    for group, link in requested:
        body = bodies.get(link)
        body_name = str(body.get("body") if body else "")
        records.append(
            _record_plan(
                link=link,
                group=group,
                body=body,
                children=children.get(body_name, []),
                joints=joints.get(body_name, []),
                actuated_joint_names=actuated,
                hardware=hardware_links.get(link),
                supplier_plans=supplier_links.get(link, []),
            )
        )
    body_ready = [record for record in records if record["body"]]
    kinematic_ready = [record for record in records if record["kinematic_proxy_ready"]]
    supplier_proxy_ready = [
        record for record in records if record["supplier_mate_feature_proxy_ready"]
    ]
    supplier_exact_ready = [
        record for record in records if record["supplier_exact_placement_ready"]
    ]
    exact_measurement_ready = [
        record for record in records if record["exact_bore_fastener_measurements_ready"]
    ]
    ok = bool(
        assembly.get("ok")
        and supplier.get("ok")
        and hardware.get("ok")
        and len(records) == 28
        and len(body_ready) == 28
    )
    accepted = bool(
        ok
        and len(exact_measurement_ready) == len(records)
        and len(supplier_exact_ready) == len(supplier_proxy_ready)
        and assembly.get("accepted")
        and supplier.get("accepted")
        and hardware.get("accepted")
    )
    return {
        "schema": FEMBOT_MATE_FEATURES_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "assembly_schema": assembly.get("schema"),
            "supplier_pocket_schema": supplier.get("schema"),
            "hardware_measurements_schema": hardware.get("schema"),
        },
        "summary": {
            "links": len(records),
            "body_link_records": len(body_ready),
            "kinematic_proxy_ready_links": len(kinematic_ready),
            "joint_mate_links": sum(1 for record in records if record["joint_names"]),
            "actuated_mate_links": sum(
                1 for record in records if record["actuated_joint_names"]
            ),
            "child_interface_links": sum(1 for record in records if record["child_links"]),
            "supplier_pocket_links": sum(
                1 for record in records if record["supplier_pocket_plan_count"] > 0
            ),
            "supplier_mate_feature_proxy_ready_links": len(supplier_proxy_ready),
            "supplier_exact_placement_ready_links": len(supplier_exact_ready),
            "exact_bore_fastener_measurement_ready_links": len(exact_measurement_ready),
            "missing_exact_bore_fastener_measurement_links": sorted(
                record["link"]
                for record in records
                if not record["exact_bore_fastener_measurements_ready"]
            ),
            "required_mate_feature_records": sum(
                int(record["required_mate_feature_count"]) for record in records
            ),
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "kinematic mate proxies are mapped for all links, but exact "
                "production bores, bearing/ring seats, fasteners, supplier "
                "pocket faces, placement transforms, and post-placement "
                "collision/structural validations are still missing"
            ),
        },
        "links": records,
    }


def dump_fembot_mate_features_plan_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_mate_features_plan_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-mate-features-plan.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_mate_features_plan_proof_json(report), encoding="utf-8")
    return output
