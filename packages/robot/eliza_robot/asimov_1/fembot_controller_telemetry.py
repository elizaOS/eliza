"""Hardware controller telemetry requirements for ASIMOV fembot actuators."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_controller_validation import (
    MAX_FINAL_ABS_ERROR_RAD,
    MAX_FINAL_MEDIAN_ABS_ERROR_RAD,
    MAX_RESPONSE_OVERSHOOT_FRACTION,
    build_fembot_controller_validation_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_CONTROLLER_TELEMETRY_SCHEMA = "asimov-fembot-controller-telemetry-plan-v1"
JOINT_LINK_ALIASES = {
    "LEFT_ANKLE_PITCH": "LEFT_ANKLE_A",
    "RIGHT_ANKLE_PITCH": "RIGHT_ANKLE_A",
    "LEFT_ANKLE_ROLL": "LEFT_ANKLE_B",
    "RIGHT_ANKLE_ROLL": "RIGHT_ANKLE_B",
}


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _joint_to_link(joint: str) -> str:
    name = joint
    if name.endswith("_joint"):
        name = name[: -len("_joint")]
    return JOINT_LINK_ALIASES.get(name.upper(), name.upper())


def _telemetry_requirements(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "field": "commanded_target_rad",
            "source": "controller command packet",
            "target_value": record.get("target_rad"),
            "required": True,
        },
        {
            "field": "measured_position_rad",
            "source": "motor encoder or joint encoder",
            "tolerance_abs_error_rad": MAX_FINAL_ABS_ERROR_RAD,
            "required": True,
        },
        {
            "field": "measured_velocity_rad_s",
            "source": "motor encoder derivative or driver telemetry",
            "required": True,
        },
        {
            "field": "current_or_torque",
            "source": "motor driver telemetry",
            "required": True,
        },
        {
            "field": "control_latency_s",
            "source": "timestamped command/feedback pair",
            "required": True,
        },
        {
            "field": "temperature_c",
            "source": "motor or driver thermal telemetry",
            "required": True,
        },
    ]


def _record_plan(record: dict[str, Any]) -> dict[str, Any]:
    final_error = float(record.get("final_abs_error_rad") or 0.0)
    response = record.get("response_fraction")
    response_fraction = float(response) if response is not None else None
    simulated_ok = bool(
        final_error <= MAX_FINAL_ABS_ERROR_RAD
        and (
            response_fraction is None
            or abs(response_fraction) <= MAX_RESPONSE_OVERSHOOT_FRACTION
        )
    )
    return {
        "actuator_index": int(record["actuator_index"]),
        "joint": record["joint"],
        "link": _joint_to_link(str(record["joint"])),
        "qpos_adr": record.get("qpos_adr"),
        "baseline_rad": record.get("baseline_rad"),
        "target_rad": record.get("target_rad"),
        "target_delta_rad": record.get("target_delta_rad"),
        "simulated_final_rad": record.get("final_rad"),
        "simulated_final_abs_error_rad": final_error,
        "simulated_response_fraction": response_fraction,
        "simulated_response_ok": simulated_ok,
        "hardware_telemetry_present": False,
        "telemetry_requirements": _telemetry_requirements(record),
        "required_telemetry_fields": [
            requirement["field"] for requirement in _telemetry_requirements(record)
        ],
        "accepted": False,
    }


def build_fembot_controller_telemetry_plan_proof(
    body_groups: list[dict[str, Any]],
    *,
    controller_validation_report: dict[str, Any] | None = None,
    hardware_telemetry_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    controller = (
        controller_validation_report
        or _load_json(ASIMOV_PARAM_PROOFS / "fembot-controller-validation.json")
        or build_fembot_controller_validation_proof(body_groups)
    )
    actuators = controller.get("rollout", {}).get("actuators") or []
    records = [_record_plan(record) for record in actuators if isinstance(record, dict)]
    hardware_by_joint: dict[str, dict[str, Any]] = {}
    if hardware_telemetry_report:
        raw = hardware_telemetry_report.get("actuators", [])
        if isinstance(raw, list):
            hardware_by_joint = {
                str(record.get("joint")): record
                for record in raw
                if isinstance(record, dict) and record.get("joint")
            }
    for record in records:
        hardware = hardware_by_joint.get(str(record["joint"]))
        if hardware and hardware.get("accepted"):
            record["hardware_telemetry_present"] = True
            record["accepted"] = True
            record["hardware_telemetry"] = hardware
    missing = [record for record in records if not record["hardware_telemetry_present"]]
    simulated_failures = [
        record for record in records if not record["simulated_response_ok"]
    ]
    requested_links = {
        str(link).upper()
        for group in body_groups
        for link in group.get("links", [])
    }
    actuator_links = {record["link"] for record in records}
    ok = bool(
        controller.get("ok")
        and len(records) == 25
        and len(requested_links) == 28
        and not simulated_failures
    )
    accepted = bool(ok and not missing and controller.get("accepted"))
    return {
        "schema": FEMBOT_CONTROLLER_TELEMETRY_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "controller_validation_schema": controller.get("schema"),
            "hardware_telemetry_schema": (hardware_telemetry_report or {}).get("schema"),
        },
        "summary": {
            "actuators": len(records),
            "actuated_links": len(actuator_links),
            "non_actuated_links": sorted(requested_links - actuator_links),
            "simulated_response_ok_actuators": len(records) - len(simulated_failures),
            "simulated_response_failure_actuators": len(simulated_failures),
            "hardware_telemetry_present_actuators": len(records) - len(missing),
            "missing_hardware_telemetry_actuators": len(missing),
            "required_telemetry_fields_per_actuator": 6,
            "required_telemetry_records": len(records) * 6,
            "max_simulated_final_abs_error_rad": max(
                (float(record["simulated_final_abs_error_rad"]) for record in records),
                default=0.0,
            ),
            "max_simulated_response_fraction_abs": max(
                (
                    abs(float(record["simulated_response_fraction"]))
                    for record in records
                    if record.get("simulated_response_fraction") is not None
                ),
                default=0.0,
            ),
            "final_abs_error_tolerance_rad": MAX_FINAL_ABS_ERROR_RAD,
            "final_median_abs_error_tolerance_rad": MAX_FINAL_MEDIAN_ABS_ERROR_RAD,
            "max_response_overshoot_fraction": MAX_RESPONSE_OVERSHOOT_FRACTION,
            "accepted": accepted,
            "acceptance_blocker": None
            if accepted
            else (
                "simulated actuator rollout is bounded, but every actuator still "
                "needs timestamped hardware command/position/velocity/current/"
                "latency/thermal telemetry before controller acceptance"
            ),
        },
        "actuators": records,
    }


def dump_fembot_controller_telemetry_plan_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_controller_telemetry_plan_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-controller-telemetry-plan.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_controller_telemetry_plan_proof_json(report),
        encoding="utf-8",
    )
    return output
