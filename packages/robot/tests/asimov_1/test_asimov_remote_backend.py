from __future__ import annotations

import asyncio
from dataclasses import dataclass

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


@dataclass(frozen=True)
class _Frame:
    joint_positions: dict[str, float]
    joint_velocities: dict[str, float]
    mode: str = "STAND"
    joint_current: list[float] | None = None
    joint_temp: list[float] | None = None
    imu_quat: list[float] | None = None
    imu_gyro: list[float] | None = None
    imu_gravity: list[float] | None = None
    sequence: int = 42
    timestamp_us: int = 1000
    fw_timestamp_us: int = 900
    error_flags: int = 0
    fw_age_ms: int = 3


class _Transport:
    def __init__(self) -> None:
        self.connected = False
        self.closed = False
        self.calls: list[tuple[str, object]] = []

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.closed = True
        self.connected = False

    async def send_mode(self, mode: str) -> None:
        self.calls.append(("mode", mode))

    async def send_velocity(self, vx_mps: float, vy_mps: float, yaw_rad_s: float) -> None:
        self.calls.append(("velocity", (vx_mps, vy_mps, yaw_rad_s)))

    async def send_trajectory(
        self,
        positions: list[float],
        *,
        kp: list[float] | None = None,
        kd: list[float] | None = None,
    ) -> None:
        self.calls.append(("trajectory", {"positions": positions, "kp": kp, "kd": kd}))

    async def read_telemetry(self) -> _Frame:
        return _Frame(
            joint_positions={f"joint-{idx}": float(idx) for idx in range(ASIMOV1_FULL_ACTION_DIM)},
            joint_velocities={f"joint-{idx}": 0.1 * idx for idx in range(ASIMOV1_FULL_ACTION_DIM)},
            joint_current=[0.2] * ASIMOV1_FULL_ACTION_DIM,
            joint_temp=[30.0] * ASIMOV1_FULL_ACTION_DIM,
            imu_quat=[1.0, 0.0, 0.0, 0.0],
            imu_gyro=[0.0, 0.1, 0.2],
            imu_gravity=[0.0, 0.0, 1.0],
        )


def _cmd(command: str, payload: dict) -> CommandEnvelope:
    return CommandEnvelope(
        request_id=f"test-{command}",
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )


def test_asimov_remote_backend_forwards_real_transport_commands_and_telemetry() -> None:
    async def run() -> None:
        transport = _Transport()
        backend = AsimovRemoteBackend(mock=False, transport=transport)
        await backend.connect()

        mode = await backend.handle_command(_cmd("asimov.mode", {"mode": "STAND"}))
        velocity = await backend.handle_command(
            _cmd("asimov.velocity", {"vx_mps": 0.4, "vy_mps": -0.2, "yaw_rad_s": 0.1})
        )
        positions = [0.01 * idx for idx in range(ASIMOV1_FULL_ACTION_DIM)]
        kp = [40.0] * ASIMOV1_FULL_ACTION_DIM
        kd = [2.0] * ASIMOV1_FULL_ACTION_DIM
        trajectory = await backend.handle_command(
            _cmd("asimov.trajectory", {"positions": positions, "kp": kp, "kd": kd})
        )
        stand = await backend.handle_command(_cmd("action.play", {"name": "stand"}))
        stop = await backend.handle_command(_cmd("walk.command", {"action": "stop"}))
        start = await backend.handle_command(_cmd("walk.command", {"action": "start"}))

        assert mode.ok and velocity.ok and trajectory.ok and stand.ok and stop.ok and start.ok
        assert transport.calls[0] == ("mode", "STAND")
        assert transport.calls[1] == ("velocity", (0.4, -0.2, 0.1))
        assert transport.calls[2] == (
            "trajectory",
            {"positions": positions, "kp": kp, "kd": kd},
        )
        assert transport.calls[3] == ("mode", "STAND")
        assert transport.calls[4] == ("mode", "DAMP")
        assert transport.calls[5] == ("mode", "STAND")

        events = await backend.poll_events()
        transport_event = events[-1]
        assert transport_event.event == "telemetry.basic"
        assert transport_event.backend == "asimov_remote"
        assert transport_event.data["mode"] == "STAND"
        assert transport_event.data["sequence"] == 42
        assert transport_event.data["imu_gravity"] == [0.0, 0.0, 1.0]

        await backend.shutdown()
        assert transport.closed is True

    asyncio.run(run())


def test_asimov_remote_backend_rejects_bad_real_trajectory_before_publish() -> None:
    async def run() -> None:
        transport = _Transport()
        backend = AsimovRemoteBackend(mock=False, transport=transport)
        await backend.connect()

        response = await backend.handle_command(
            _cmd("asimov.trajectory", {"positions": [0.0] * (ASIMOV1_FULL_ACTION_DIM - 1)})
        )

        assert response.ok is False
        assert "wrong width" in response.message
        assert transport.calls == []

    asyncio.run(run())
