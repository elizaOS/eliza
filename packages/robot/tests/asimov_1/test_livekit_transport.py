from __future__ import annotations

import asyncio
import json
import unittest
from types import SimpleNamespace

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport


class _Message:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _CloudCommand(_Message):
    last: _CloudCommand | None = None

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        _CloudCommand.last = self

    def SerializeToString(self) -> bytes:
        return json.dumps({"sequence": self.sequence, "timestamp_us": self.timestamp_us}).encode()


class _Mode:
    MODE_STAND = 0
    MODE_DAMP = 1

    @staticmethod
    def Value(name: str) -> int:
        return getattr(_Mode, name)


class _FirmwareMode:
    @staticmethod
    def Name(value: int) -> str:
        return {0: "FW_MODE_DAMP", 1: "FW_MODE_STAND", 2: "FW_MODE_MOVE"}[int(value)]


class _Telemetry(_Message):
    @staticmethod
    def FromString(_payload: bytes):
        return _Telemetry(
            timestamp_us=10,
            fw_timestamp_us=8,
            sequence=7,
            fw_mode=1,
            joint_pos=[0.1] * ASIMOV1_FULL_ACTION_DIM,
            joint_vel=[0.2] * ASIMOV1_FULL_ACTION_DIM,
            joint_current=[0.3] * ASIMOV1_FULL_ACTION_DIM,
            joint_temp=[30.0] * ASIMOV1_FULL_ACTION_DIM,
            imu_quat=[1.0, 0.0, 0.0, 0.0],
            imu_gyro=[0.0, 0.1, 0.2],
            imu_gravity=[0.0, 0.0, 1.0],
            error_flags=0,
            fw_age_ms=2,
        )


class _FakeEdgePb2:
    CloudCommand = _CloudCommand
    VelocityCommand = _Message
    TrajectoryRequest = _Message
    FullTrajectory = _Message
    JointSegment = _Message
    ModeCommand = _Message
    EdgeTelemetry = _Telemetry
    Mode = _Mode
    FirmwareMode = _FirmwareMode


class _Participant:
    def __init__(self) -> None:
        self.published = []

    async def publish_data(self, payload: bytes, *, topic: str, reliable: bool):
        self.published.append({"payload": payload, "topic": topic, "reliable": reliable})


class _Room:
    def __init__(self) -> None:
        self.local_participant = _Participant()
        self.connected = False
        self.callbacks = {}

    async def connect(self, url: str, token: str) -> None:
        self.connected = bool(url and token)

    def on(self, event: str):
        def register(fn):
            self.callbacks[event] = fn
            return fn

        return register


class LiveKitAsimovTransportTests(unittest.TestCase):
    def test_publishes_documented_velocity_cloud_command(self) -> None:
        async def run() -> None:
            room = _Room()
            transport = LiveKitAsimovTransport(
                url="wss://example.invalid",
                token="token",
                room=room,
                edge_pb2=_FakeEdgePb2,
            )
            await transport.connect()
            await transport.send_velocity(9.0, -9.0, 3.5)

            self.assertEqual(room.local_participant.published[0]["topic"], "commands")
            self.assertTrue(room.local_participant.published[0]["reliable"])
            cmd = _CloudCommand.last
            assert cmd is not None
            self.assertEqual(cmd.sequence, 1)
            self.assertEqual(cmd.velocity.vx, 2.0)
            self.assertEqual(cmd.velocity.vy, -1.0)
            self.assertEqual(cmd.velocity.vyaw, 2.0)
            self.assertFalse(hasattr(cmd, "mode"))
            self.assertFalse(hasattr(cmd, "trajectory"))

        asyncio.run(run())

    def test_publishes_documented_mode_and_trajectory_commands(self) -> None:
        async def run() -> None:
            room = _Room()
            transport = LiveKitAsimovTransport(
                url="wss://example.invalid",
                token="token",
                room=room,
                edge_pb2=_FakeEdgePb2,
            )
            await transport.connect()
            await transport.send_mode("STAND")
            mode_cmd = _CloudCommand.last
            assert mode_cmd is not None
            self.assertEqual(mode_cmd.sequence, 1)
            self.assertEqual(mode_cmd.mode.mode, _Mode.MODE_STAND)

            positions = [0.1] * ASIMOV1_FULL_ACTION_DIM
            kp = [40.0] * ASIMOV1_FULL_ACTION_DIM
            kd = [2.0] * ASIMOV1_FULL_ACTION_DIM
            await transport.send_trajectory(positions, kp=kp, kd=kd)
            traj_cmd = _CloudCommand.last
            assert traj_cmd is not None
            self.assertEqual(traj_cmd.sequence, 2)
            segment = traj_cmd.trajectory.full.segments[0]
            self.assertEqual(segment.positions, positions)
            self.assertEqual(segment.kp, kp)
            self.assertEqual(segment.kd, kd)

        asyncio.run(run())

    def test_rejects_malformed_trajectory_before_publish(self) -> None:
        async def run() -> None:
            room = _Room()
            transport = LiveKitAsimovTransport(
                url="wss://example.invalid",
                token="token",
                room=room,
                edge_pb2=_FakeEdgePb2,
            )
            await transport.connect()
            with self.assertRaises(ValueError):
                await transport.send_trajectory([0.0] * (ASIMOV1_FULL_ACTION_DIM - 1))
            self.assertEqual(room.local_participant.published, [])

        asyncio.run(run())

    def test_parses_edge_telemetry_frame(self) -> None:
        transport = LiveKitAsimovTransport(
            url="wss://example.invalid",
            token="token",
            room=SimpleNamespace(),
            edge_pb2=_FakeEdgePb2,
        )
        frame = transport.handle_telemetry_payload(b"telemetry")
        self.assertEqual(frame.mode, "STAND")
        self.assertEqual(frame.sequence, 7)
        self.assertEqual(len(frame.joint_positions), ASIMOV1_FULL_ACTION_DIM)
        self.assertEqual(len(frame.joint_velocities), ASIMOV1_FULL_ACTION_DIM)

    def test_waits_for_livekit_data_packet_telemetry_without_command(self) -> None:
        async def run() -> None:
            room = _Room()
            transport = LiveKitAsimovTransport(
                url="wss://example.invalid",
                token="token",
                room=room,
                edge_pb2=_FakeEdgePb2,
            )
            await transport.connect()
            self.assertIn("data_received", room.callbacks)
            room.callbacks["data_received"](SimpleNamespace(topic="telemetry", data=b"telemetry"))
            frame = await transport.wait_for_telemetry(timeout_s=0.1)
            self.assertEqual(frame.sequence, 7)
            self.assertEqual(room.local_participant.published, [])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
