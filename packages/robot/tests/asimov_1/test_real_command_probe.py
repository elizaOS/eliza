from __future__ import annotations

import asyncio

from eliza_robot.asimov_1.livekit_dry_run import FakeAsimovEdgePb2, FakeLiveKitRoom
from eliza_robot.asimov_1.livekit_transport import LiveKitAsimovTransport
from eliza_robot.asimov_1.real_command_probe import probe_real_command_sequence


def test_staged_real_command_probe_defaults_to_telemetry_then_damp_only() -> None:
    async def run() -> None:
        room = FakeLiveKitRoom()
        transport = LiveKitAsimovTransport(
            url="wss://asimov.probe.invalid",
            token="token",
            room=room,
            edge_pb2=FakeAsimovEdgePb2,
        )

        async def connect_and_emit(url: str, token: str) -> None:
            await FakeLiveKitRoom.connect(room, url, token)
            room.handlers["data_received"](type("Packet", (), {"topic": "telemetry", "data": b"telemetry"})())

        room.connect = connect_and_emit
        report = await probe_real_command_sequence(transport, timeout_s=0.1)
        assert report["ok"] is True
        assert report["commands_sent"] == ["mode:DAMP"]
        assert report["checks"]["telemetry_before_commands"] is True
        assert len(room.local_participant.published) == 1

    asyncio.run(run())


def test_staged_real_command_probe_requires_flags_for_stand_and_zero_velocity() -> None:
    async def run() -> None:
        room = FakeLiveKitRoom()
        transport = LiveKitAsimovTransport(
            url="wss://asimov.probe.invalid",
            token="token",
            room=room,
            edge_pb2=FakeAsimovEdgePb2,
        )

        async def connect_and_emit(url: str, token: str) -> None:
            await FakeLiveKitRoom.connect(room, url, token)
            room.handlers["data_received"](type("Packet", (), {"topic": "telemetry", "data": b"telemetry"})())

        room.connect = connect_and_emit
        report = await probe_real_command_sequence(
            transport,
            timeout_s=0.1,
            allow_stand=True,
            allow_zero_velocity=True,
        )
        assert report["ok"] is True
        assert report["commands_sent"] == ["mode:DAMP", "mode:STAND", "velocity:zero"]
        assert len(room.local_participant.published) == 3

    asyncio.run(run())
