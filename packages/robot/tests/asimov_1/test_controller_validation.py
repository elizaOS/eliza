from __future__ import annotations

import math

import pytest

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER
from eliza_robot.asimov_1.controller import AsimovController, AsimovMode
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.bridge.validation import validate_command_payload
from scripts.validate_asimov1_controller_contract import (  # noqa: E402
    validate_asimov1_controller_contract,
)


def _cmd(command: str, payload: dict) -> CommandEnvelope:
    return CommandEnvelope(
        request_id=f"test-{command}",
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )


def test_asimov_controller_clamps_velocity_and_watchdogs_trajectory() -> None:
    controller = AsimovController()
    controller.set_mode("STAND")

    controller.set_velocity(9.0, -9.0, 3.0)
    assert controller.mode == AsimovMode.MOVE
    assert controller.velocity == {"vx_mps": 2.0, "vy_mps": -1.0, "yaw_rad_s": 2.0}

    controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: 0.25})
    assert controller.mode == AsimovMode.TRAJECTORY
    assert controller.joint_targets[ASIMOV1_FIRMWARE_JOINT_ORDER[0]] == 0.25
    assert controller.watchdog_expired(now=controller.updated_at + 2.0) is True
    assert controller.watchdog_expired(now=controller.updated_at + 0.1) is False


def test_asimov_controller_rejects_velocity_in_damp() -> None:
    controller = AsimovController()
    with pytest.raises(ValueError, match="require STAND"):
        controller.set_velocity(0.1, 0.0, 0.0)


def test_asimov_controller_rejects_unknown_or_nonfinite_targets() -> None:
    controller = AsimovController()
    with pytest.raises(ValueError, match="unknown ASIMOV joints"):
        controller.set_trajectory({"not_a_joint": 0.0})
    with pytest.raises(ValueError, match="must be finite"):
        controller.set_trajectory({ASIMOV1_FIRMWARE_JOINT_ORDER[0]: math.nan})


def test_shared_validator_accepts_asimov_velocity_aliases() -> None:
    validate_command_payload(
        _cmd("walk.command", {"vx_mps": 0.2, "vy_mps": -0.1, "yaw_rad_s": 0.5})
    )
    validate_command_payload(_cmd("walk.set", {"x": 0.2, "y": -0.1, "yaw": 0.5}))
    validate_command_payload(_cmd("asimov.velocity", {"x": 0.2, "y": -0.1, "yaw": 0.5}))


def test_shared_validator_rejects_out_of_range_asimov_aliases() -> None:
    with pytest.raises(ValueError, match="ASIMOV range"):
        validate_command_payload(_cmd("walk.set", {"x": 2.5, "y": 0.0, "yaw": 0.0}))
    with pytest.raises(ValueError, match="ASIMOV range"):
        validate_command_payload(_cmd("walk.command", {"vx_mps": 0.0, "vy_mps": 0.0, "yaw_rad_s": 3.0}))


def test_asimov_controller_contract_validator() -> None:
    report = validate_asimov1_controller_contract()

    assert report["ok"] is True
    assert all(report["checks"].values())
    assert report["checks"]["trajectory_watchdog_200ms"] is True
    assert report["checks"]["rejects_velocity_in_damp"] is True
    assert report["velocity"] == {"vx_mps": 2.0, "vy_mps": -1.0, "yaw_rad_s": 2.0}
