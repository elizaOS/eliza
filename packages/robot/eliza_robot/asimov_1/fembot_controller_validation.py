"""Fembot controller validation proof for simulated and hardware bring-up."""

from __future__ import annotations

import json
import math
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_TRAJECTORY_WATCHDOG_S,
)
from eliza_robot.asimov_1.controller import AsimovController, AsimovMode
from eliza_robot.asimov_1.fembot_mjcf import generate_fembot_mjcf
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS

FEMBOT_CONTROLLER_VALIDATION_SCHEMA = "asimov-fembot-controller-validation-proof-v1"
CONTROLLER_ROLLOUT_SECONDS = 0.75
CONTROLLER_TARGET_STEP_RAD = 0.02
JOINT_LIMIT_TOLERANCE_RAD = 0.01
EARLY_RESPONSE_TIME_S = 0.02
SETTLED_RESPONSE_TIME_S = 0.25
MAX_FINAL_ABS_ERROR_RAD = 0.10
MAX_FINAL_MEDIAN_ABS_ERROR_RAD = 0.02
MAX_RESPONSE_OVERSHOOT_FRACTION = 4.0


def _controller_contract_report() -> dict[str, Any]:
    controller = AsimovController()
    checks: dict[str, bool] = {}
    details: dict[str, Any] = {
        "firmware_joint_order": list(ASIMOV1_FIRMWARE_JOINT_ORDER),
        "trajectory_watchdog_s": ASIMOV1_TRAJECTORY_WATCHDOG_S,
    }

    controller.set_mode("STAND")
    controller.set_velocity(9.0, -9.0, 3.0)
    checks["velocity_clamped_in_stand"] = controller.velocity == {
        "vx_mps": 2.0,
        "vy_mps": -1.0,
        "yaw_rad_s": 2.0,
    }
    details["clamped_velocity"] = dict(controller.velocity)

    controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: 0.25})
    checks["trajectory_mode_entered"] = controller.mode == AsimovMode.TRAJECTORY
    checks["trajectory_watchdog_expires"] = controller.watchdog_expired(
        now=controller.updated_at + ASIMOV1_TRAJECTORY_WATCHDOG_S + 0.01
    )
    checks["trajectory_watchdog_holds_before_timeout"] = not controller.watchdog_expired(
        now=controller.updated_at + ASIMOV1_TRAJECTORY_WATCHDOG_S * 0.5
    )

    damp_controller = AsimovController()
    try:
        damp_controller.set_velocity(0.1, 0.0, 0.0)
    except ValueError:
        checks["rejects_velocity_in_damp"] = True
    else:
        checks["rejects_velocity_in_damp"] = False

    try:
        controller.set_trajectory({"not_a_joint": 0.0})
    except ValueError:
        checks["rejects_unknown_trajectory_joint"] = True
    else:
        checks["rejects_unknown_trajectory_joint"] = False

    try:
        controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: math.nan})
    except ValueError:
        checks["rejects_nonfinite_trajectory_target"] = True
    else:
        checks["rejects_nonfinite_trajectory_target"] = False

    return {
        "ok": all(checks.values()),
        "checks": checks,
        "details": details,
    }


def _actuator_joint_names(model: Any, mujoco: Any) -> list[str]:
    names: list[str] = []
    for actuator_index in range(model.nu):
        joint_id = int(model.actuator_trnid[actuator_index, 0])
        if joint_id < 0:
            names.append("")
            continue
        names.append(
            str(
                mujoco.mj_id2name(
                    model,
                    mujoco.mjtObj.mjOBJ_JOINT,
                    joint_id,
                )
            )
        )
    return names


def _target_for_actuator(
    *,
    model: Any,
    actuator_index: int,
    baseline: np.ndarray,
) -> float:
    joint_id = int(model.actuator_trnid[actuator_index, 0])
    qpos_adr = int(model.jnt_qposadr[joint_id])
    base = float(baseline[qpos_adr])
    direction = 1.0 if actuator_index % 2 == 0 else -1.0
    target = base + direction * CONTROLLER_TARGET_STEP_RAD
    if bool(model.actuator_ctrllimited[actuator_index]):
        lo, hi = [float(value) for value in model.actuator_ctrlrange[actuator_index]]
        if target > hi or target < lo:
            target = base - direction * CONTROLLER_TARGET_STEP_RAD
        target = float(np.clip(target, lo, hi))
    return target


def _rollout_report(*, mjcf_path: Path) -> dict[str, Any]:
    try:
        import mujoco
    except ImportError as exc:  # pragma: no cover - exercised only without MuJoCo.
        return {"ok": False, "reason": f"mujoco_import_failed: {exc}"}

    model = mujoco.MjModel.from_xml_path(str(mjcf_path))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    actuator_joint_names = _actuator_joint_names(model, mujoco)
    actuator_order_ok = actuator_joint_names == list(ASIMOV1_FIRMWARE_JOINT_ORDER)
    baseline_qpos = np.asarray(data.qpos, dtype=np.float64).copy()

    controller = AsimovController()
    controller.set_mode("STAND")
    targets_by_joint: dict[str, float] = {}
    actuator_records: list[dict[str, Any]] = []
    controls = np.zeros(model.nu, dtype=np.float64)
    for actuator_index, joint_name in enumerate(actuator_joint_names):
        joint_id = int(model.actuator_trnid[actuator_index, 0])
        qpos_adr = int(model.jnt_qposadr[joint_id])
        target = _target_for_actuator(
            model=model,
            actuator_index=actuator_index,
            baseline=baseline_qpos,
        )
        controls[actuator_index] = target
        targets_by_joint[joint_name] = target
        actuator_records.append(
            {
                "actuator_index": actuator_index,
                "joint": joint_name,
                "joint_id": joint_id,
                "qpos_adr": qpos_adr,
                "baseline_rad": float(baseline_qpos[qpos_adr]),
                "target_rad": target,
                "target_delta_rad": float(target - baseline_qpos[qpos_adr]),
            }
        )

    controller.set_trajectory(targets_by_joint)
    data.ctrl[:] = controls

    step_count = max(1, int(round(CONTROLLER_ROLLOUT_SECONDS / float(model.opt.timestep))))
    sample_steps = {
        max(1, int(round(seconds / float(model.opt.timestep)))): seconds
        for seconds in (
            EARLY_RESPONSE_TIME_S,
            0.10,
            SETTLED_RESPONSE_TIME_S,
            0.50,
            CONTROLLER_ROLLOUT_SECONDS,
        )
    }
    samples: list[dict[str, Any]] = []
    max_abs_qvel = 0.0
    finite_state_ok = True
    for step in range(1, step_count + 1):
        mujoco.mj_step(model, data)
        finite_state_ok = finite_state_ok and bool(
            np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))
        )
        max_abs_qvel = max(max_abs_qvel, float(np.max(np.abs(data.qvel), initial=0.0)))
        if step not in sample_steps:
            continue
        errors, responses = _tracking_errors(data=data, actuator_records=actuator_records)
        samples.append(
            {
                "time_s": sample_steps[step],
                "max_abs_error_rad": max(errors, default=0.0),
                "median_abs_error_rad": float(median(errors)) if errors else 0.0,
                "median_response_fraction": float(median(responses)) if responses else 0.0,
            }
        )

    errors, responses = _tracking_errors(data=data, actuator_records=actuator_records)
    joint_limit_violations = _joint_limit_violations(
        model=model,
        mujoco=mujoco,
        qpos=np.asarray(data.qpos, dtype=np.float64),
    )
    control_range_violations = _control_range_violations(model=model, controls=controls)
    final_records = []
    for record in actuator_records:
        qpos_adr = int(record["qpos_adr"])
        target = float(record["target_rad"])
        baseline = float(record["baseline_rad"])
        delta = target - baseline
        final = float(data.qpos[qpos_adr])
        final_records.append(
            {
                **record,
                "final_rad": final,
                "final_abs_error_rad": abs(final - target),
                "response_fraction": ((final - baseline) / delta if abs(delta) > 1e-12 else 1.0),
            }
        )
    response_fractions = [
        float(record["response_fraction"]) for record in final_records
    ]
    response_overshoot_records = [
        record
        for record in final_records
        if abs(float(record["response_fraction"])) > MAX_RESPONSE_OVERSHOOT_FRACTION
    ]
    early_sample = next(
        (
            sample
            for sample in samples
            if abs(float(sample["time_s"]) - EARLY_RESPONSE_TIME_S) <= 1e-9
        ),
        None,
    )
    settled_sample = next(
        (
            sample
            for sample in samples
            if abs(float(sample["time_s"]) - SETTLED_RESPONSE_TIME_S) <= 1e-9
        ),
        None,
    )
    final_max_abs_error = max(errors, default=0.0)
    final_median_abs_error = float(median(errors)) if errors else 0.0
    motor_response_profile_ok = bool(
        final_records
        and early_sample is not None
        and settled_sample is not None
        and early_sample["median_response_fraction"] is not None
        and settled_sample["median_response_fraction"] is not None
        and 0.0 <= float(early_sample["median_response_fraction"]) < 0.5
        and float(settled_sample["median_response_fraction"]) > float(
            early_sample["median_response_fraction"]
        )
        and final_max_abs_error <= MAX_FINAL_ABS_ERROR_RAD
        and final_median_abs_error <= MAX_FINAL_MEDIAN_ABS_ERROR_RAD
        and not response_overshoot_records
    )

    rollout_ok = bool(
        actuator_order_ok
        and finite_state_ok
        and not joint_limit_violations
        and not control_range_violations
        and motor_response_profile_ok
        and len(final_records) == len(ASIMOV1_FIRMWARE_JOINT_ORDER)
    )
    return {
        "ok": rollout_ok,
        "duration_s": CONTROLLER_ROLLOUT_SECONDS,
        "target_step_rad": CONTROLLER_TARGET_STEP_RAD,
        "actuator_order_ok": actuator_order_ok,
        "actuator_joint_order": actuator_joint_names,
        "actuators_commanded": len(final_records),
        "finite_state_ok": finite_state_ok,
        "joint_limit_ok": not joint_limit_violations,
        "joint_limit_tolerance_rad": JOINT_LIMIT_TOLERANCE_RAD,
        "joint_limit_violations": joint_limit_violations,
        "control_range_ok": not control_range_violations,
        "control_range_violations": control_range_violations,
        "max_abs_qvel_rad_s": max_abs_qvel,
        "final_max_abs_error_rad": final_max_abs_error,
        "final_median_abs_error_rad": final_median_abs_error,
        "final_median_response_fraction": float(median(responses)) if responses else 0.0,
        "motor_response_profile_ok": motor_response_profile_ok,
        "early_response_time_s": EARLY_RESPONSE_TIME_S,
        "settled_response_time_s": SETTLED_RESPONSE_TIME_S,
        "early_median_response_fraction": early_sample["median_response_fraction"]
        if early_sample
        else None,
        "settled_median_response_fraction": settled_sample["median_response_fraction"]
        if settled_sample
        else None,
        "max_final_abs_error_tolerance_rad": MAX_FINAL_ABS_ERROR_RAD,
        "max_final_median_abs_error_tolerance_rad": MAX_FINAL_MEDIAN_ABS_ERROR_RAD,
        "max_response_overshoot_fraction": MAX_RESPONSE_OVERSHOOT_FRACTION,
        "response_overshoot_count": len(response_overshoot_records),
        "min_final_response_fraction": min(response_fractions, default=None),
        "max_final_response_fraction": max(response_fractions, default=None),
        "samples": samples,
        "actuators": final_records,
    }


def _tracking_errors(
    *,
    data: Any,
    actuator_records: list[dict[str, Any]],
) -> tuple[list[float], list[float]]:
    errors: list[float] = []
    responses: list[float] = []
    for record in actuator_records:
        qpos_adr = int(record["qpos_adr"])
        target = float(record["target_rad"])
        baseline = float(record["baseline_rad"])
        delta = target - baseline
        final = float(data.qpos[qpos_adr])
        errors.append(abs(final - target))
        responses.append((final - baseline) / delta if abs(delta) > 1e-12 else 1.0)
    return errors, responses


def _joint_limit_violations(*, model: Any, mujoco: Any, qpos: np.ndarray) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    for joint_id in range(model.njnt):
        if not bool(model.jnt_limited[joint_id]):
            continue
        qpos_adr = int(model.jnt_qposadr[joint_id])
        value = float(qpos[qpos_adr])
        lo, hi = [float(item) for item in model.jnt_range[joint_id]]
        if value < lo - JOINT_LIMIT_TOLERANCE_RAD or value > hi + JOINT_LIMIT_TOLERANCE_RAD:
            violations.append(
                {
                    "joint": mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id),
                    "value_rad": value,
                    "range_rad": [lo, hi],
                }
            )
    return violations


def _control_range_violations(*, model: Any, controls: np.ndarray) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    for actuator_index, value in enumerate(controls):
        if not bool(model.actuator_ctrllimited[actuator_index]):
            continue
        lo, hi = [float(item) for item in model.actuator_ctrlrange[actuator_index]]
        if float(value) < lo or float(value) > hi:
            violations.append(
                {
                    "actuator_index": actuator_index,
                    "control_rad": float(value),
                    "range_rad": [lo, hi],
                }
            )
    return violations


def build_fembot_controller_validation_proof(
    body_groups: list[dict[str, Any]],
    *,
    source_mjcf: Path = ASIMOV1_GENERATED_MJCF,
    fembot_mjcf_report: dict[str, Any] | None = None,
    hardware_controller_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fembot_mjcf = fembot_mjcf_report or generate_fembot_mjcf()
    proof_mjcf_path = Path(fembot_mjcf.get("output", {}).get("mjcf", source_mjcf))
    contract = _controller_contract_report()
    rollout = _rollout_report(mjcf_path=proof_mjcf_path)
    hardware_validated = bool(
        hardware_controller_report
        and hardware_controller_report.get("ok")
        and hardware_controller_report.get("accepted")
    )
    body_group_links = {
        str(link).upper()
        for group in body_groups
        for link in group.get("links", [])
    }
    ok = bool(
        len(body_group_links) == 28
        and fembot_mjcf.get("ok")
        and contract.get("ok")
        and rollout.get("ok")
    )
    accepted = bool(ok and hardware_validated)
    return {
        "schema": FEMBOT_CONTROLLER_VALIDATION_SCHEMA,
        "ok": ok,
        "accepted": accepted,
        "source": {
            "source_mjcf": str(source_mjcf),
            "fembot_mjcf": str(proof_mjcf_path),
            "fembot_mjcf_schema": fembot_mjcf.get("schema"),
            "hardware_controller_schema": (
                hardware_controller_report or {}
            ).get("schema"),
        },
        "summary": {
            "local_controller_contract_ok": bool(contract.get("ok")),
            "mujoco_controller_rollout_ok": bool(rollout.get("ok")),
            "actuator_order_ok": bool(rollout.get("actuator_order_ok")),
            "actuators_commanded": rollout.get("actuators_commanded", 0),
            "finite_state_ok": bool(rollout.get("finite_state_ok")),
            "joint_limit_ok": bool(rollout.get("joint_limit_ok")),
            "control_range_ok": bool(rollout.get("control_range_ok")),
            "motor_response_profile_ok": bool(
                rollout.get("motor_response_profile_ok")
            ),
            "trajectory_final_max_abs_error_rad": rollout.get("final_max_abs_error_rad"),
            "trajectory_final_median_abs_error_rad": rollout.get(
                "final_median_abs_error_rad"
            ),
            "trajectory_final_median_response_fraction": rollout.get(
                "final_median_response_fraction"
            ),
            "trajectory_early_median_response_fraction": rollout.get(
                "early_median_response_fraction"
            ),
            "trajectory_settled_median_response_fraction": rollout.get(
                "settled_median_response_fraction"
            ),
            "trajectory_response_overshoot_count": rollout.get(
                "response_overshoot_count"
            ),
            "trajectory_min_final_response_fraction": rollout.get(
                "min_final_response_fraction"
            ),
            "trajectory_max_final_response_fraction": rollout.get(
                "max_final_response_fraction"
            ),
            "max_abs_qvel_rad_s": rollout.get("max_abs_qvel_rad_s"),
            "hardware_controller_validated": hardware_validated,
            "accepted": accepted,
            "acceptance_blocker": (
                "simulated controller contract, command order, bounded controls, "
                "joint limits, and finite MuJoCo rollout pass; production acceptance "
                "still needs hardware motor-controller telemetry and bring-up validation"
                if ok and not hardware_validated
                else None
            ),
        },
        "contract": contract,
        "rollout": rollout,
        "hardware_controller": hardware_controller_report,
    }


def dump_fembot_controller_validation_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_controller_validation_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-controller-validation.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        dump_fembot_controller_validation_proof_json(report),
        encoding="utf-8",
    )
    return output
