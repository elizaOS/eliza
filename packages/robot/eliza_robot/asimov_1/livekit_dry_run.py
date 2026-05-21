"""Local ASIMOV LiveKit/protobuf dry-run validation helpers."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER, ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


class _Message:
    def __init__(self, **kwargs: Any) -> None:
        self.__dict__.update(kwargs)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in self.__dict__.items():
            if isinstance(value, _Message):
                out[key] = value.to_json()
            elif isinstance(value, list):
                out[key] = [item.to_json() if isinstance(item, _Message) else item for item in value]
            else:
                out[key] = value
        return out


class _CloudCommand(_Message):
    last: _CloudCommand | None = None

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        _CloudCommand.last = self

    def SerializeToString(self) -> bytes:
        return json.dumps(self.to_json(), sort_keys=True).encode("utf-8")


class _Mode:
    MODE_STAND = 0
    MODE_DAMP = 1

    @staticmethod
    def Value(name: str) -> int:
        return int(getattr(_Mode, name))


class _FirmwareMode:
    @staticmethod
    def Name(value: int) -> str:
        return {0: "FW_MODE_DAMP", 1: "FW_MODE_STAND", 2: "FW_MODE_MOVE"}[int(value)]


class _Telemetry(_Message):
    @staticmethod
    def FromString(_payload: bytes) -> _Telemetry:
        return _Telemetry(
            timestamp_us=1000,
            fw_timestamp_us=950,
            sequence=77,
            fw_mode=1,
            joint_pos=[0.01 * idx for idx in range(ASIMOV1_FULL_ACTION_DIM)],
            joint_vel=[0.001 * idx for idx in range(ASIMOV1_FULL_ACTION_DIM)],
            joint_current=[0.2] * ASIMOV1_FULL_ACTION_DIM,
            joint_temp=[31.0] * ASIMOV1_FULL_ACTION_DIM,
            imu_quat=[1.0, 0.0, 0.0, 0.0],
            imu_gyro=[0.0, 0.1, 0.2],
            imu_gravity=[0.0, 0.0, 1.0],
            error_flags=0,
            fw_age_ms=5,
        )


class FakeAsimovEdgePb2:
    CloudCommand = _CloudCommand
    VelocityCommand = _Message
    TrajectoryRequest = _Message
    FullTrajectory = _Message
    JointSegment = _Message
    ModeCommand = _Message
    EdgeTelemetry = _Telemetry
    Mode = _Mode
    FirmwareMode = _FirmwareMode


@dataclass
class FakePublishedData:
    payload: bytes
    topic: str
    reliable: bool


class FakeLiveKitParticipant:
    def __init__(self) -> None:
        self.published: list[FakePublishedData] = []

    async def publish_data(self, payload: bytes, *, topic: str, reliable: bool) -> None:
        self.published.append(FakePublishedData(payload=payload, topic=topic, reliable=reliable))


class FakeLiveKitRoom:
    def __init__(self) -> None:
        self.local_participant = FakeLiveKitParticipant()
        self.connected = False
        self.url = ""
        self.token = ""
        self.handlers: dict[str, Any] = {}

    async def connect(self, url: str, token: str) -> None:
        self.connected = bool(url and token)
        self.url = url
        self.token = token

    async def disconnect(self) -> None:
        self.connected = False

    def on(self, event: str) -> Any:
        def register(fn: Any) -> Any:
            self.handlers[event] = fn
            return fn

        return register


def _cmd(command: str, payload: dict[str, Any]) -> CommandEnvelope:
    return CommandEnvelope(
        request_id=f"dry-run-{command}",
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )


async def validate_asimov_livekit_dry_run_async() -> dict[str, Any]:
    """Exercise the real ASIMOV backend path with fake LiveKit/protobuf objects."""
    room = FakeLiveKitRoom()
    transport = LiveKitAsimovTransport(
        url="wss://asimov.dry-run.invalid",
        token="dry-run-token",
        room=room,
        edge_pb2=FakeAsimovEdgePb2,
    )
    backend = AsimovRemoteBackend(mock=False, transport=transport)
    await backend.connect()

    positions = [0.01 * idx for idx in range(ASIMOV1_FULL_ACTION_DIM)]
    kp = [40.0] * ASIMOV1_FULL_ACTION_DIM
    kd = [2.0] * ASIMOV1_FULL_ACTION_DIM
    responses = [
        await backend.handle_command(_cmd("asimov.mode", {"mode": "STAND"})),
        await backend.handle_command(
            _cmd("asimov.velocity", {"vx_mps": 0.3, "vy_mps": -0.1, "yaw_rad_s": 0.2})
        ),
        await backend.handle_command(_cmd("asimov.trajectory", {"positions": positions, "kp": kp, "kd": kd})),
    ]
    transport.handle_telemetry_payload(b"dry-run-telemetry")
    events = await backend.poll_events()
    await backend.shutdown()

    published = room.local_participant.published
    decoded = [json.loads(item.payload.decode("utf-8")) for item in published]
    telemetry_events = [event for event in events if event.event == "telemetry.basic"]
    telemetry = telemetry_events[-1].data if telemetry_events else {}
    command_shapes = [
        sorted(key for key in item if key not in {"sequence", "timestamp_us"})
        for item in decoded
    ]
    checks = {
        "connected": room.url == "wss://asimov.dry-run.invalid" and room.token == "dry-run-token",
        "responses_ok": all(response.ok for response in responses),
        "published_count": len(published) == 3,
        "all_reliable": all(item.reliable for item in published),
        "command_topic": all(item.topic == "commands" for item in published),
        "mode_command": command_shapes[0] == ["mode"],
        "velocity_command": command_shapes[1] == ["velocity"],
        "trajectory_command": command_shapes[2] == ["trajectory"],
        "sequence_order": [item["sequence"] for item in decoded] == [1, 2, 3],
        "trajectory_width": len(decoded[2]["trajectory"]["full"]["segments"][0]["positions"]) == ASIMOV1_FULL_ACTION_DIM,
        "telemetry_sequence": telemetry.get("sequence") == 77,
        "telemetry_joint_width": len(telemetry.get("joint_positions", {})) == ASIMOV1_FULL_ACTION_DIM,
        "shutdown": room.connected is False,
    }
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "transport": "livekit",
        "protobuf": "edge.generated.edge_cloud_pb2-compatible",
        "command_topic": "commands",
        "telemetry_track": "telemetry",
        "joint_order": list(ASIMOV1_FIRMWARE_JOINT_ORDER),
        "checks": checks,
        "published_commands": decoded,
        "telemetry": telemetry,
    }


def validate_asimov_livekit_dry_run() -> dict[str, Any]:
    return asyncio.run(validate_asimov_livekit_dry_run_async())
