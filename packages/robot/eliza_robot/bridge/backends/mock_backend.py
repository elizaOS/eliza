"""Mock backend for bridge development without ROS or robot hardware."""

from __future__ import annotations

import math
from dataclasses import dataclass
from random import random

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, utc_now_iso
from eliza_robot.bridge.types import JsonDict


@dataclass
class WalkState:
    enabled: bool = True
    is_walking: bool = False
    speed: int = 2
    height: float = 0.036
    x: float = 0.0
    y: float = 0.0
    angle: float = 0.0


@dataclass
class MockHeadState:
    pan: float = 0.0
    tilt: float = 0.0


class MockBackend(BridgeBackend):
    """Simple in-memory backend that emulates key robot controls."""

    def __init__(self) -> None:
        self._state = WalkState()
        self._head = MockHeadState()
        self._battery_mv = 12300
        self._joint_positions: dict[str, float] = {}  # joint_name -> radians

    @property
    def backend_name(self) -> str:
        return "mock"

    async def connect(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_stream_passthrough": False,
            "camera_snapshot": True,
        }

    def snapshot_camera(self, _camera: str = "head") -> np.ndarray | None:
        """Return a deterministic synthetic frame that encodes the current
        robot heading + head pan + step count.

        The frame is a 320×240 RGB gradient whose color shifts as `walk_yaw`
        and `head_pan` change. Pixel-diff tests can compare two snapshots
        taken before and after a motion and assert the image moved.
        """
        width, height = 320, 240
        # Hue rotates with composite yaw heading; saturation rises with speed.
        hue = (self._state.angle * 18.0 + self._head.pan * 90.0 + 360.0) % 360.0
        sat = 0.4 + 0.15 * min(self._state.speed, 4)
        val = 0.85
        c = val * sat
        x = c * (1 - abs((hue / 60.0) % 2 - 1))
        m = val - c
        if hue < 60:
            r, g, b = c, x, 0.0
        elif hue < 120:
            r, g, b = x, c, 0.0
        elif hue < 180:
            r, g, b = 0.0, c, x
        elif hue < 240:
            r, g, b = 0.0, x, c
        elif hue < 300:
            r, g, b = x, 0.0, c
        else:
            r, g, b = c, 0.0, x
        base = np.zeros((height, width, 3), dtype=np.uint8)
        # Per-row vertical gradient so the frame is non-uniform.
        for row in range(height):
            shade = 0.5 + 0.5 * math.sin(row / height * math.pi + self._state.angle)
            base[row, :, 0] = int(255 * (r + m) * shade)
            base[row, :, 1] = int(255 * (g + m) * shade)
            base[row, :, 2] = int(255 * (b + m) * shade)
        # Mark walk state with a top-left bar (red while walking, green idle)
        if self._state.is_walking:
            base[0:10, 0:60] = (255, 60, 60)
        else:
            base[0:10, 0:60] = (60, 255, 60)
        return base

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        message = "ok"
        ok = True

        if cmd.command == "walk.set":
            self._state.speed = int(cmd.payload.get("speed", 2))
            self._state.height = float(cmd.payload.get("height", 0.036))
            self._state.x = float(cmd.payload.get("x", 0.0))
            self._state.y = float(cmd.payload.get("y", 0.0))
            self._state.angle = float(cmd.payload.get("yaw", 0.0))
        elif cmd.command == "walk.command":
            action = cmd.payload.get("action")
            if action == "start":
                self._state.is_walking = True
            elif action == "stop":
                self._state.is_walking = False
            elif action == "enable":
                self._state.enabled = True
            elif action == "disable":
                self._state.enabled = False
                self._state.is_walking = False
            else:
                ok = False
                message = "unsupported walk.command action"
        elif cmd.command == "head.set":
            self._head.pan = float(cmd.payload.get("pan", 0.0))
            self._head.tilt = float(cmd.payload.get("tilt", 0.0))
        elif cmd.command == "action.play":
            pass
        elif cmd.command == "servo.set":
            # Track joint positions from direct joint control.
            # Accept both formats:
            #   joint_positions: {name: radians} (from policy)
            #   positions: [{id, position}] (from ROS-formatted dispatch)
            jp = cmd.payload.get("joint_positions", {})
            if isinstance(jp, dict):
                self._joint_positions.update(jp)
            positions = cmd.payload.get("positions", [])
            if isinstance(positions, list):
                from eliza_robot.bridge.isaaclab.joint_map import servo_id_to_joint_name, pulse_to_radians
                for item in positions:
                    if isinstance(item, dict) and "id" in item and "position" in item:
                        name = servo_id_to_joint_name(int(item["id"]))
                        self._joint_positions[name] = pulse_to_radians(
                            int(item["position"]), int(item["id"])
                        )
        else:
            ok = False
            message = f"unsupported command: {cmd.command}"

        return ResponseEnvelope(
            request_id=cmd.request_id,
            timestamp=utc_now_iso(),
            ok=ok,
            backend=self.backend_name,
            message=message,
            data={
                "walk_enabled": self._state.enabled,
                "is_walking": self._state.is_walking,
            },
        )

    async def poll_events(self) -> list[EventEnvelope]:
        self._battery_mv = max(10400, self._battery_mv - int(1 + 2 * random()))
        telemetry = EventEnvelope(
            event="telemetry.basic",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "battery_mv": self._battery_mv,
                "is_walking": self._state.is_walking,
                "imu_roll": 0.0,
                "imu_pitch": 0.0,
                "walk_x": self._state.x,
                "walk_y": self._state.y,
                "walk_yaw": self._state.angle,
                "walk_speed": self._state.speed,
                "walk_height": self._state.height,
                "head_pan": self._head.pan,
                "head_tilt": self._head.tilt,
                "joint_positions": dict(self._joint_positions),
            },
        )
        perception = EventEnvelope(
            event="telemetry.perception",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "entities": [
                    {
                        "entity_id": "mock-red-ball-01",
                        "label": "red ball",
                        "confidence": 0.98,
                        "x": 0.0,
                        "y": 0.0,
                        "z": 0.4,
                        "source": "mock",
                    }
                ]
            },
        )
        return [telemetry, perception]

