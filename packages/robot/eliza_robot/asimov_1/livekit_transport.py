"""Optional LiveKit transport for ASIMOV-1 hardware.

The import boundary is intentionally lazy: development and CI can validate the
ASIMOV bridge without Menlo's generated protobuf package or LiveKit installed.
"""

from __future__ import annotations

import asyncio
import itertools
import math
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER, ASIMOV1_FULL_ACTION_DIM


@dataclass(frozen=True)
class AsimovTelemetryFrame:
    joint_positions: dict[str, float]
    joint_velocities: dict[str, float]
    mode: str = "DAMP"
    joint_current: list[float] | None = None
    joint_temp: list[float] | None = None
    imu_quat: list[float] | None = None
    imu_gyro: list[float] | None = None
    imu_gravity: list[float] | None = None
    sequence: int = 0
    timestamp_us: int = 0
    fw_timestamp_us: int = 0
    error_flags: int = 0
    fw_age_ms: int = 0


class LiveKitAsimovTransport:
    """LiveKit/protobuf client for the documented ASIMOV hardware API.

    ASIMOV commands are `CloudCommand` protobuf envelopes published to the
    reliable `commands` topic. Telemetry is parsed from `EdgeTelemetry`
    protobuf payloads when callers feed frames through `handle_telemetry_payload`
    or when a compatible LiveKit DataTrack is published.
    """

    def __init__(
        self,
        *,
        url: str,
        token: str,
        room: Any | None = None,
        edge_pb2: Any | None = None,
    ) -> None:
        self.url = url
        self.token = token
        self.connected = False
        self.room: Any = room
        self.edge_pb2: Any = edge_pb2
        self._seq = itertools.count(1)
        self._latest_telemetry: AsimovTelemetryFrame | None = None
        self._telemetry_event = asyncio.Event()

    async def connect(self) -> None:
        if not self.url:
            raise ValueError("ASIMOV LiveKit URL is required for asimov-real")
        if not self.token:
            raise ValueError("ASIMOV LiveKit token is required for asimov-real")
        if self.room is None:
            try:
                from livekit import rtc
            except ModuleNotFoundError as exc:
                raise ModuleNotFoundError("asimov-real requires `livekit`; install `livekit` and `livekit-api`") from exc
            self.room = rtc.Room()
        if self.edge_pb2 is None:
            try:
                from edge.generated import edge_cloud_pb2
            except ModuleNotFoundError as exc:
                raise ModuleNotFoundError("asimov-real requires Menlo edge protobufs at edge.generated.edge_cloud_pb2") from exc
            self.edge_pb2 = edge_cloud_pb2
        if hasattr(self.room, "on"):
            self._register_room_event("data_received", self._on_data_received)
            self._register_room_event("data_track_published", self._on_data_track_published)
        if hasattr(self.room, "connect") and not getattr(self.room, "connected", False):
            await self.room.connect(self.url, self.token)
        self.connected = True

    async def close(self) -> None:
        if self.room is not None and hasattr(self.room, "disconnect"):
            result = self.room.disconnect()
            if hasattr(result, "__await__"):
                await result
        self.connected = False

    async def send_mode(self, mode: str) -> None:
        mode = mode.upper()
        if mode not in {"DAMP", "STAND"}:
            raise ValueError("ASIMOV hardware mode API only supports DAMP and STAND")
        pb = self._require_pb2()
        enum_name = "MODE_DAMP" if mode == "DAMP" else "MODE_STAND"
        command = pb.CloudCommand(
            timestamp_us=self._timestamp_us(),
            sequence=self._next_sequence(),
            mode=pb.ModeCommand(mode=self._enum_value(pb.Mode, enum_name, enum_name)),
        )
        await self._publish_command(command)

    async def send_velocity(self, vx_mps: float, vy_mps: float, yaw_rad_s: float) -> None:
        for value in (vx_mps, vy_mps, yaw_rad_s):
            if not math.isfinite(float(value)):
                raise ValueError("ASIMOV velocity commands must be finite")
        vx = max(-2.0, min(2.0, float(vx_mps)))
        vy = max(-1.0, min(1.0, float(vy_mps)))
        vyaw = max(-2.0, min(2.0, float(yaw_rad_s)))
        pb = self._require_pb2()
        command = pb.CloudCommand(
            timestamp_us=self._timestamp_us(),
            sequence=self._next_sequence(),
            velocity=pb.VelocityCommand(vx=vx, vy=vy, vyaw=vyaw),
        )
        await self._publish_command(command)

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
        pb = self._require_pb2()
        segment_kwargs = {"positions": [float(value) for value in positions]}
        if kp is not None:
            segment_kwargs["kp"] = [float(value) for value in kp]
        if kd is not None:
            segment_kwargs["kd"] = [float(value) for value in kd]
        command = pb.CloudCommand(
            timestamp_us=self._timestamp_us(),
            sequence=self._next_sequence(),
            trajectory=pb.TrajectoryRequest(
                full=pb.FullTrajectory(
                    segments=[
                        pb.JointSegment(**segment_kwargs),
                    ]
                )
            ),
        )
        await self._publish_command(command)

    async def read_telemetry(self) -> AsimovTelemetryFrame:
        if self._latest_telemetry is not None:
            return self._latest_telemetry
        return AsimovTelemetryFrame(
            joint_positions={name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER},
            joint_velocities={name: 0.0 for name in ASIMOV1_FIRMWARE_JOINT_ORDER},
        )

    async def wait_for_telemetry(self, *, timeout_s: float = 10.0) -> AsimovTelemetryFrame:
        """Wait for a real telemetry frame without sending a command."""
        if self._latest_telemetry is not None:
            return self._latest_telemetry
        await asyncio.wait_for(self._telemetry_event.wait(), timeout=float(timeout_s))
        if self._latest_telemetry is None:
            raise TimeoutError("ASIMOV telemetry event fired but no frame was cached")
        return self._latest_telemetry

    def handle_telemetry_payload(self, payload: bytes) -> AsimovTelemetryFrame:
        pb = self._require_pb2()
        telemetry = pb.EdgeTelemetry.FromString(payload)
        frame = AsimovTelemetryFrame(
            joint_positions=self._joint_map(getattr(telemetry, "joint_pos", [])),
            joint_velocities=self._joint_map(getattr(telemetry, "joint_vel", [])),
            mode=self._firmware_mode_name(getattr(telemetry, "fw_mode", 0)),
            joint_current=[float(v) for v in getattr(telemetry, "joint_current", [])],
            joint_temp=[float(v) for v in getattr(telemetry, "joint_temp", [])],
            imu_quat=[float(v) for v in getattr(telemetry, "imu_quat", [])],
            imu_gyro=[float(v) for v in getattr(telemetry, "imu_gyro", [])],
            imu_gravity=[float(v) for v in getattr(telemetry, "imu_gravity", [])],
            sequence=int(getattr(telemetry, "sequence", 0)),
            timestamp_us=int(getattr(telemetry, "timestamp_us", 0)),
            fw_timestamp_us=int(getattr(telemetry, "fw_timestamp_us", 0)),
            error_flags=int(getattr(telemetry, "error_flags", 0)),
            fw_age_ms=int(getattr(telemetry, "fw_age_ms", 0)),
        )
        self._latest_telemetry = frame
        self._telemetry_event.set()
        return frame

    async def _publish_command(self, command: Any) -> None:
        if not self.connected:
            raise RuntimeError("ASIMOV LiveKit transport is not connected")
        participant = getattr(self.room, "local_participant", None)
        if participant is None or not hasattr(participant, "publish_data"):
            raise RuntimeError("ASIMOV LiveKit room does not expose local_participant.publish_data")
        result = participant.publish_data(
            command.SerializeToString(),
            topic="commands",
            reliable=True,
        )
        if hasattr(result, "__await__"):
            await result

    def _on_data_track_published(self, track: Any, *_args: Any) -> None:
        name = str(getattr(track, "name", "") or getattr(track, "topic", ""))
        if name and name != "telemetry":
            return
        with suppress(RuntimeError):
            asyncio.create_task(self._read_telemetry_track(track))

    def _on_data_received(self, data_packet: Any, *_args: Any) -> None:
        topic = str(getattr(data_packet, "topic", ""))
        if topic and topic != "telemetry":
            return
        payload = getattr(data_packet, "data", None)
        if payload is None:
            payload = getattr(data_packet, "payload", data_packet)
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.handle_telemetry_payload(bytes(payload))

    def _register_room_event(self, event: str, callback: Any) -> None:
        registrar = self.room.on(event)
        if callable(registrar):
            result = registrar(callback)
            if result is None or result is callback:
                return
        with suppress(TypeError):
            self.room.on(event, callback)

    async def _read_telemetry_track(self, track: Any) -> None:
        stream = track.subscribe()
        async for frame in stream:
            payload = getattr(frame, "payload", frame)
            self.handle_telemetry_payload(payload)

    def _require_pb2(self) -> Any:
        if self.edge_pb2 is None:
            raise RuntimeError("ASIMOV Menlo edge protobuf module is not loaded")
        return self.edge_pb2

    def _next_sequence(self) -> int:
        return next(self._seq)

    @staticmethod
    def _timestamp_us() -> int:
        return int(time.time() * 1_000_000)

    @staticmethod
    def _enum_value(enum: Any, name: str, fallback_attr: str) -> Any:
        if hasattr(enum, "Value"):
            try:
                return enum.Value(name)
            except Exception:
                pass
        if hasattr(enum, fallback_attr):
            return getattr(enum, fallback_attr)
        raise AttributeError(f"ASIMOV protobuf enum is missing {name}")

    @staticmethod
    def _joint_map(values: Any) -> dict[str, float]:
        vals = list(values)
        if len(vals) != ASIMOV1_FULL_ACTION_DIM:
            vals = (vals + [0.0] * ASIMOV1_FULL_ACTION_DIM)[:ASIMOV1_FULL_ACTION_DIM]
        return {name: float(value) for name, value in zip(ASIMOV1_FIRMWARE_JOINT_ORDER, vals, strict=True)}

    def _firmware_mode_name(self, value: Any) -> str:
        pb = self._require_pb2()
        fw_mode = getattr(pb, "FirmwareMode", None)
        if fw_mode is not None and hasattr(fw_mode, "Name"):
            try:
                name = str(fw_mode.Name(value))
                return name.removeprefix("FW_MODE_")
            except Exception:
                pass
        if int(value) == 1:
            return "STAND"
        if int(value) == 2:
            return "MOVE"
        return "DAMP"
