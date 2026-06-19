"""ASIMOV-1 mock/remote bridge backend."""

from __future__ import annotations

import math
import time
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER
from eliza_robot.asimov_1.controller import AsimovController
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport
from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import (
    CommandEnvelope,
    EventEnvelope,
    ResponseEnvelope,
    utc_now_iso,
)


def _positions_from_payload(payload: dict) -> dict[str, float]:
    if isinstance(payload.get("joint_positions"), dict):
        return {str(k): float(v) for k, v in payload["joint_positions"].items()}
    positions = payload.get("positions", [])
    if isinstance(positions, list) and positions and not isinstance(positions[0], dict):
        if len(positions) != len(ASIMOV1_FIRMWARE_JOINT_ORDER):
            raise ValueError("ASIMOV trajectory position list has wrong width")
        return {name: float(value) for name, value in zip(ASIMOV1_FIRMWARE_JOINT_ORDER, positions, strict=True)}
    return {}


def _full_gain_array(payload: dict, key: str) -> list[float] | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != len(ASIMOV1_FIRMWARE_JOINT_ORDER):
        raise ValueError(f"{key} must be a {len(ASIMOV1_FIRMWARE_JOINT_ORDER)}-element list")
    out = [float(v) for v in value]
    if not all(math.isfinite(v) for v in out):
        raise ValueError(f"{key} gains must be finite")
    return out


class AsimovRemoteBackend(BridgeBackend):
    def __init__(
        self,
        *,
        profile_id: str = "asimov-1",
        mock: bool = True,
        livekit_url: str = "",
        livekit_token: str = "",
        transport: Any | None = None,
    ) -> None:
        self.profile_id = profile_id
        self.mock = mock
        self.controller = AsimovController()
        self.transport = transport if transport is not None else (
            None if mock else LiveKitAsimovTransport(url=livekit_url, token=livekit_token)
        )
        self._events: list[EventEnvelope] = []

    @property
    def backend_name(self) -> str:
        return "asimov_mock" if self.mock else "asimov_remote"

    async def connect(self) -> None:
        if self.transport is not None:
            await self.transport.connect()
        self._events.append(self._telemetry_event())

    async def shutdown(self) -> None:
        if self.transport is not None:
            await self.transport.close()

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        try:
            if cmd.command == "asimov.mode":
                mode = str(cmd.payload.get("mode", ""))
                self.controller.set_mode(mode)
                if self.transport:
                    await self.transport.send_mode(mode)
                data = {"mode": self.controller.mode.value}
            elif cmd.command == "walk.command" and "action" in cmd.payload:
                action = str(cmd.payload.get("action", "")).lower()
                mode = "DAMP" if action in {"stop", "disable", "disable_control"} else "STAND"
                self.controller.set_mode(mode)
                if self.transport:
                    await self.transport.send_mode(mode)
                data = {"action": action, "mode": self.controller.mode.value}
            elif cmd.command in {"asimov.velocity", "walk.command", "walk.set"}:
                vx = float(cmd.payload.get("vx_mps", cmd.payload.get("x", 0.0)))
                vy = float(cmd.payload.get("vy_mps", cmd.payload.get("y", 0.0)))
                yaw = float(cmd.payload.get("yaw_rad_s", cmd.payload.get("yaw", 0.0)))
                self.controller.set_velocity(vx, vy, yaw)
                if self.transport:
                    await self.transport.send_velocity(vx, vy, yaw)
                data = {"velocity": self.controller.velocity}
            elif cmd.command in {"asimov.trajectory", "servo.set", "policy.tick"}:
                targets = _positions_from_payload(cmd.payload)
                self.controller.set_trajectory(targets)
                if self.transport:
                    positions = [self.controller.joint_targets[name] for name in ASIMOV1_FIRMWARE_JOINT_ORDER]
                    await self.transport.send_trajectory(
                        positions,
                        kp=_full_gain_array(cmd.payload, "kp"),
                        kd=_full_gain_array(cmd.payload, "kd"),
                    )
                data = {"joint_targets": dict(self.controller.joint_targets)}
            elif cmd.command == "action.play":
                if cmd.payload.get("name") == "stand":
                    self.controller.set_mode("STAND")
                    if self.transport:
                        await self.transport.send_mode("STAND")
                data = {"action": cmd.payload.get("name", "")}
            else:
                data = {}
            self._events.append(self._telemetry_event())
            return ResponseEnvelope(cmd.request_id, utc_now_iso(), True, self.backend_name, "ok", data)
        except Exception as exc:
            return ResponseEnvelope(cmd.request_id, utc_now_iso(), False, self.backend_name, str(exc), {})

    async def poll_events(self) -> list[EventEnvelope]:
        if self.controller.watchdog_expired():
            self.controller.set_mode("DAMP")
            if self.transport:
                await self.transport.send_mode("DAMP")
            self._events.append(
                EventEnvelope(
                    "safety.deadman_triggered",
                    utc_now_iso(),
                    self.backend_name,
                    {"reason": "asimov_trajectory_watchdog"},
                )
            )
        if self.transport is not None and hasattr(self.transport, "read_telemetry"):
            try:
                frame = await self.transport.read_telemetry()
                self._events.append(self._telemetry_frame_event(frame))
            except Exception as exc:
                damp_error = None
                self.controller.set_mode("DAMP")
                if self.transport:
                    try:
                        await self.transport.send_mode("DAMP")
                    except Exception as damp_exc:
                        damp_error = str(damp_exc)
                data = {
                    "reason": "asimov_invalid_telemetry",
                    "error": str(exc),
                    "mode": self.controller.mode.value,
                }
                if damp_error is not None:
                    data["damp_command_error"] = damp_error
                self._events.append(
                    EventEnvelope(
                        "safety.telemetry_invalid",
                        utc_now_iso(),
                        self.backend_name,
                        data,
                    )
                )
        events, self._events = self._events, []
        return events

    def capabilities(self) -> dict:
        return {
            "profile_id": self.profile_id,
            "connected": self.mock or bool(self.transport and self.transport.connected),
            "mock": self.mock,
            "dof": len(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "transport": "mock" if self.mock else "livekit",
            "command_topic": "commands" if not self.mock else None,
            "telemetry_track": "telemetry" if not self.mock else None,
            "commands": [
                "asimov.mode",
                "asimov.velocity",
                "asimov.trajectory",
                "walk.command",
                "walk.set",
                "servo.set",
                "policy.tick",
                "action.play",
            ],
        }

    def _telemetry_event(self) -> EventEnvelope:
        data = self.controller.telemetry()
        data.update(
            {
                "joint_positions": dict(self.controller.joint_targets),
                "joint_velocities": {name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER},
                "time_s": time.time(),
            }
        )
        return EventEnvelope("telemetry.basic", utc_now_iso(), self.backend_name, data)

    def _telemetry_frame_event(self, frame: Any) -> EventEnvelope:
        joint_positions = dict(getattr(frame, "joint_positions", {}) or {})
        joint_velocities = dict(getattr(frame, "joint_velocities", {}) or {})
        data = {
            "profile_id": self.profile_id,
            "mode": str(getattr(frame, "mode", self.controller.mode.value)),
            "joint_order": list(ASIMOV1_FIRMWARE_JOINT_ORDER),
            "joint_positions": joint_positions,
            "joint_velocities": joint_velocities,
            "joint_current": list(getattr(frame, "joint_current", []) or []),
            "joint_temp": list(getattr(frame, "joint_temp", []) or []),
            "imu_quat": list(getattr(frame, "imu_quat", []) or []),
            "imu_gyro": list(getattr(frame, "imu_gyro", []) or []),
            "imu_gravity": list(getattr(frame, "imu_gravity", []) or []),
            "sequence": int(getattr(frame, "sequence", 0)),
            "timestamp_us": int(getattr(frame, "timestamp_us", 0)),
            "fw_timestamp_us": int(getattr(frame, "fw_timestamp_us", 0)),
            "error_flags": int(getattr(frame, "error_flags", 0)),
            "fw_age_ms": int(getattr(frame, "fw_age_ms", 0)),
            "time_s": time.time(),
        }
        return EventEnvelope("telemetry.basic", utc_now_iso(), self.backend_name, data)
