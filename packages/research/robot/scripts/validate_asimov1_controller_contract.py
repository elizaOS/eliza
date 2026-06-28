#!/usr/bin/env python3
"""Validate the ASIMOV-1 local controller and command alias contract."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_TRAJECTORY_WATCHDOG_S,
)
from eliza_robot.asimov_1.controller import AsimovController, AsimovMode  # noqa: E402
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso  # noqa: E402
from eliza_robot.bridge.validation import validate_command_payload  # noqa: E402


def _cmd(command: str, payload: dict[str, Any]) -> CommandEnvelope:
    return CommandEnvelope(
        request_id=f"asimov-controller-contract-{command}",
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )


def _raises_value_error(fn) -> bool:
    try:
        fn()
    except ValueError:
        return True
    return False


def validate_asimov1_controller_contract() -> dict[str, Any]:
    controller = AsimovController()
    controller.set_mode("STAND")
    mode_ok = controller.mode == AsimovMode.STAND

    controller.set_velocity(9.0, -9.0, 3.0)
    velocity_ok = controller.mode == AsimovMode.MOVE and controller.velocity == {
        "vx_mps": 2.0,
        "vy_mps": -1.0,
        "yaw_rad_s": 2.0,
    }

    controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: 0.25})
    trajectory_ok = (
        controller.mode == AsimovMode.TRAJECTORY
        and len(controller.joint_targets) == len(ASIMOV1_FIRMWARE_JOINT_ORDER)
        and controller.joint_targets[ASIMOV1_FIRMWARE_JOINT_ORDER[0]] == 0.25
    )
    watchdog_ok = controller.watchdog_expired(
        now=controller.updated_at + ASIMOV1_TRAJECTORY_WATCHDOG_S + 0.1
    )
    rejects_unknown = _raises_value_error(lambda: controller.set_trajectory({"no_joint": 0.0}))
    rejects_nonfinite = _raises_value_error(
        lambda: controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: math.nan})
    )
    damp_velocity_controller = AsimovController()
    rejects_velocity_in_damp = _raises_value_error(
        lambda: damp_velocity_controller.set_velocity(0.1, 0.0, 0.0)
    )
    alias_checks = {
        "walk_command_velocity": _raises_value_error(
            lambda: validate_command_payload(
                _cmd("walk.command", {"vx_mps": 2.5, "vy_mps": 0.0, "yaw_rad_s": 0.0})
            )
        )
        and validate_command_payload(
            _cmd("walk.command", {"vx_mps": 0.2, "vy_mps": -0.1, "yaw_rad_s": 0.5})
        )
        is None,
        "walk_set": validate_command_payload(_cmd("walk.set", {"x": 0.2, "y": -0.1, "yaw": 0.5}))
        is None,
        "asimov_velocity": validate_command_payload(
            _cmd("asimov.velocity", {"x": 0.2, "y": -0.1, "yaw": 0.5})
        )
        is None,
        "trajectory_width": validate_command_payload(
            _cmd("asimov.trajectory", {"positions": [0.0] * len(ASIMOV1_FIRMWARE_JOINT_ORDER)})
        )
        is None,
    }
    telemetry = controller.telemetry()
    checks = {
        "mode": mode_ok,
        "velocity_clamp": velocity_ok,
        "trajectory": trajectory_ok,
        "trajectory_watchdog": watchdog_ok,
        "trajectory_watchdog_200ms": ASIMOV1_TRAJECTORY_WATCHDOG_S == 0.2,
        "rejects_unknown_joint": rejects_unknown,
        "rejects_nonfinite_target": rejects_nonfinite,
        "rejects_velocity_in_damp": rejects_velocity_in_damp,
        "alias_validation": all(alias_checks.values()),
        "telemetry_shape": telemetry.get("profile_id") == "asimov-1"
        and len(telemetry.get("joint_order", [])) == len(ASIMOV1_FIRMWARE_JOINT_ORDER)
        and len(telemetry.get("joint_targets", {})) == len(ASIMOV1_FIRMWARE_JOINT_ORDER),
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "controller": "AsimovController",
        "checks": checks,
        "alias_checks": alias_checks,
        "velocity": controller.velocity,
        "telemetry": telemetry,
    }


def main() -> int:
    report = validate_asimov1_controller_contract()
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
