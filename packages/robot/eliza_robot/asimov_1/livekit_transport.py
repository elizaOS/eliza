"""Optional LiveKit transport for ASIMOV-1 hardware.

The import boundary is intentionally lazy: development and CI can validate the
ASIMOV bridge without Menlo's generated protobuf package or LiveKit installed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER, ASIMOV1_FULL_ACTION_DIM


@dataclass(frozen=True)
class AsimovTelemetryFrame:
    joint_positions: dict[str, float]
    joint_velocities: dict[str, float]
    mode: str = "DAMP"


class LiveKitAsimovTransport:
    def __init__(self, *, url: str, token: str) -> None:
        self.url = url
        self.token = token
        self.connected = False
        self.room: Any = None
        self.edge_pb2: Any = None

    async def connect(self) -> None:
        if not self.url:
            raise ValueError("ASIMOV LiveKit URL is required for asimov-real")
        if not self.token:
            raise ValueError("ASIMOV LiveKit token is required for asimov-real")
        try:
            from livekit import rtc  # noqa: F401
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError("asimov-real requires `livekit`; install `livekit` and `livekit-api`") from exc
        try:
            from edge.generated import edge_cloud_pb2
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError("asimov-real requires Menlo edge protobufs at edge.generated.edge_cloud_pb2") from exc
        self.edge_pb2 = edge_cloud_pb2
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    async def send_mode(self, mode: str) -> None:
        if mode.upper() not in {"DAMP", "STAND"}:
            raise ValueError("ASIMOV hardware mode API only supports DAMP and STAND")

    async def send_velocity(self, vx_mps: float, vy_mps: float, yaw_rad_s: float) -> None:
        for value in (vx_mps, vy_mps, yaw_rad_s):
            if not math.isfinite(float(value)):
                raise ValueError("ASIMOV velocity commands must be finite")

    async def send_trajectory(
        self,
        positions: list[float],
        *,
        kp: list[float] | None = None,
        kd: list[float] | None = None,
    ) -> None:
        if len(positions) != ASIMOV1_FULL_ACTION_DIM:
            raise ValueError(f"ASIMOV trajectory requires {ASIMOV1_FULL_ACTION_DIM} positions")
        for value in positions:
            if not math.isfinite(float(value)):
                raise ValueError("ASIMOV trajectory positions must be finite")
        for name, values, lo, hi in (("kp", kp, 0.0, 500.0), ("kd", kd, 0.0, 5.0)):
            if values is None:
                continue
            if len(values) != ASIMOV1_FULL_ACTION_DIM:
                raise ValueError(f"{name} must contain {ASIMOV1_FULL_ACTION_DIM} gains")
            for value in values:
                if not math.isfinite(float(value)) or not lo <= float(value) <= hi:
                    raise ValueError(f"{name} gains must be finite and in range {lo}..{hi}")

    async def read_telemetry(self) -> AsimovTelemetryFrame:
        return AsimovTelemetryFrame(
            joint_positions={name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER},
            joint_velocities={name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER},
        )
