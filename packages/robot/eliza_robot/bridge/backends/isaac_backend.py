"""IsaacLab backend for command-envelope websocket protocol.

Maps command-envelope operations (walk.set, walk.command, action.play, head.set)
to the shared simulation state. When Isaac Sim runtime is available, this
backend synchronizes with the live articulation; otherwise it uses the
deterministic in-memory state surrogate.
"""

from __future__ import annotations

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.isaaclab.joint_map import JOINT_BY_SERVO_ID, pulse_to_radians
from eliza_robot.bridge.isaaclab.sim_state import SimRobotState
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, utc_now_iso
from eliza_robot.bridge.types import JsonDict


class IsaacBackend(BridgeBackend):
    """IsaacLab backend for the command-envelope server."""

    def __init__(self) -> None:
        self._state = SimRobotState()

    @property
    def backend_name(self) -> str:
        return "isaac"

    async def connect(self) -> None:
        self._state.ready = True

    async def shutdown(self) -> None:
        self._state.ready = False

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_stream_passthrough": True,
            "runtime": "isaaclab",
        }

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        if not self._state.ready:
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self.backend_name,
                message="backend not connected",
                data={},
            )

        try:
            self._dispatch(cmd)
            self._state.tick()
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=True,
                backend=self.backend_name,
                message="ok",
                data={
                    "is_walking": self._state.walk.is_walking,
                    "battery_mv": self._state.battery_mv,
                },
            )
        except Exception as exc:
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self.backend_name,
                message=str(exc),
                data={},
            )

    def _dispatch(self, cmd: CommandEnvelope) -> None:
        if cmd.command == "walk.set":
            self._state.apply_walk_params(
                speed=int(cmd.payload.get("speed", 2)),
                height=float(cmd.payload.get("height", 0.036)),
                x=float(cmd.payload.get("x", 0.0)),
                y=float(cmd.payload.get("y", 0.0)),
                angle=float(cmd.payload.get("yaw", 0.0)),
            )
            return

        if cmd.command == "walk.command":
            action_value = cmd.payload.get("action")
            if not isinstance(action_value, str):
                raise ValueError("walk.command payload.action must be a string")
            if not self._state.apply_walk_command(action_value):
                raise ValueError(f"unsupported walk command: {action_value}")
            return

        if cmd.command == "action.play":
            action_name = cmd.payload.get("name")
            if not isinstance(action_name, str) or action_name == "":
                raise ValueError("action.play payload.name must be a non-empty string")
            self._state.apply_action(action_name)
            return

        if cmd.command == "head.set":
            pan = float(cmd.payload.get("pan", 0.0))
            tilt = float(cmd.payload.get("tilt", 0.0))
            self._state.apply_head(pan=pan, tilt=tilt)
            return

        if cmd.command == "servo.set":
            duration = float(cmd.payload.get("duration", 0.3))
            positions_value = cmd.payload.get("positions")
            if not isinstance(positions_value, list):
                raise ValueError("servo.set payload.positions must be a list")
            for item in positions_value:
                if not isinstance(item, dict):
                    raise ValueError("servo.set position item must be an object")
                servo_id = int(item.get("id", 0))
                pulse = int(item.get("position", 500))
                spec = JOINT_BY_SERVO_ID.get(servo_id)
                if spec is not None:
                    rad = pulse_to_radians(pulse, servo_id)
                    self._state.joint_positions_rad[spec.urdf_name] = rad
            return

        raise ValueError(f"unsupported command: {cmd.command}")

    async def poll_events(self) -> list[EventEnvelope]:
        if not self._state.ready:
            return []
        self._state.tick()
        # Compute IMU roll/pitch from quaternion
        import math
        q = self._state.imu_orientation
        x, y, z, w = q.get("x", 0.0), q.get("y", 0.0), q.get("z", 0.0), q.get("w", 1.0)
        sinr_cosp = 2.0 * (w * x + y * z)
        cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
        imu_roll = math.atan2(sinr_cosp, cosr_cosp)
        sinp = 2.0 * (w * y - z * x)
        imu_pitch = math.asin(max(-1.0, min(1.0, sinp)))

        return [
            EventEnvelope(
                event="telemetry.basic",
                timestamp=utc_now_iso(),
                backend=self.backend_name,
                data={
                    "is_walking": self._state.walk.is_walking,
                    "battery_mv": self._state.battery_mv,
                    "imu_roll": imu_roll,
                    "imu_pitch": imu_pitch,
                    "walk_x": self._state.walk.x,
                    "walk_y": self._state.walk.y,
                    "walk_yaw": self._state.walk.angle,
                    "walk_height": self._state.walk.height,
                    "walk_speed": self._state.walk.speed,
                    "head_pan": self._state.head.pan,
                    "head_tilt": self._state.head.tilt,
                },
            )
        ]
