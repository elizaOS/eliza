"""Small stateful ASIMOV command controller used by bridge backends."""

from __future__ import annotations

import math
import time
from enum import StrEnum

from eliza_robot.asimov_1.constants import (
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_TRAJECTORY_WATCHDOG_S,
    ASIMOV1_VELOCITY_LIMITS,
)


class AsimovMode(StrEnum):
    DAMP = "DAMP"
    STAND = "STAND"
    MOVE = "MOVE"
    TRAJECTORY = "TRAJECTORY"
    POLICY = "POLICY"


class AsimovController:
    def __init__(self) -> None:
        self.mode = AsimovMode.DAMP
        self.velocity = {"vx_mps": 0.0, "vy_mps": 0.0, "yaw_rad_s": 0.0}
        self.joint_targets = {name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER}
        self.updated_at = time.time()

    def set_mode(self, mode: str) -> None:
        mode = mode.upper()
        if mode not in {"DAMP", "STAND"}:
            raise ValueError("direct ASIMOV mode commands only support DAMP and STAND")
        self.mode = AsimovMode(mode)
        self.updated_at = time.time()

    def set_velocity(self, vx_mps: float, vy_mps: float, yaw_rad_s: float) -> None:
        values = {"vx_mps": vx_mps, "vy_mps": vy_mps, "yaw_rad_s": yaw_rad_s}
        for key, value in values.items():
            if not math.isfinite(float(value)):
                raise ValueError(f"{key} must be finite")
            limit = ASIMOV1_VELOCITY_LIMITS[key]
            values[key] = max(-limit, min(limit, float(value)))
        self.velocity = values
        self.mode = AsimovMode.MOVE
        self.updated_at = time.time()

    def set_trajectory(self, targets: dict[str, float]) -> None:
        unknown = set(targets) - set(ASIMOV1_FIRMWARE_JOINT_ORDER)
        if unknown:
            raise ValueError(f"unknown ASIMOV joints: {sorted(unknown)!r}")
        for name, value in targets.items():
            if not math.isfinite(float(value)):
                raise ValueError(f"target for {name} must be finite")
            self.joint_targets[name] = float(value)
        self.mode = AsimovMode.TRAJECTORY
        self.updated_at = time.time()

    def watchdog_expired(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return self.mode == AsimovMode.TRAJECTORY and (now - self.updated_at) > ASIMOV1_TRAJECTORY_WATCHDOG_S

    def telemetry(self) -> dict:
        return {
            "profile_id": "asimov-1",
            "mode": self.mode.value,
            "velocity": dict(self.velocity),
            "joint_order": list(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "joint_targets": dict(self.joint_targets),
            "timestamp_s": self.updated_at,
        }
