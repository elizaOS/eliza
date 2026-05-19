"""MuJoCo bridge backend -- runs MuJoCo simulation instead of real hardware.

Implements the ``BridgeBackend`` interface so the bridge server (and any
websocket client, including the Eliza plugin) can drive a simulated AiNex
through the same protocol used for the real robot.

Usage:
    from training.mujoco.demo_env import DemoEnv
    from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend

    env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    backend = MuJocoBackend(env)
    # Pass ``backend`` to the bridge server or use directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, utc_now_iso
from eliza_robot.bridge.types import JsonDict


@dataclass
class _WalkState:
    """Tracks high-level walk command state within the backend."""
    enabled: bool = True
    is_walking: bool = False
    speed: int = 2
    height: float = 0.036
    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0


@dataclass
class _HeadState:
    pan: float = 0.0
    tilt: float = 0.0


class MuJocoBackend(BridgeBackend):
    """Bridge backend that runs MuJoCo simulation instead of real hardware.

    All ``handle_command`` calls translate protocol commands into MuJoCo
    actuator targets and physics steps.  ``poll_events`` returns simulated
    telemetry derived from sensor data.
    """

    def __init__(self, demo_env: Any) -> None:
        """Create a MuJoCo backend wrapping a ``DemoEnv`` instance.

        Args:
            demo_env: A ``training.mujoco.demo_env.DemoEnv`` instance.
        """
        self._env = demo_env
        self._walk = _WalkState()
        self._head = _HeadState()
        self._joint_positions: dict[str, float] = {}
        self._last_telemetry: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # BridgeBackend interface
    # ------------------------------------------------------------------

    @property
    def backend_name(self) -> str:
        return "mujoco"

    async def connect(self) -> None:
        """Reset the MuJoCo environment on connect."""
        self._last_telemetry = self._env.reset()

    async def shutdown(self) -> None:
        """Close the MuJoCo environment."""
        self._env.close()

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_stream_passthrough": False,
            "camera_snapshot": True,
            "mujoco_sim": True,
        }

    def snapshot_camera(self, _camera: str = "head") -> np.ndarray | None:
        """Render the DemoEnv's head-mounted ego camera as an (H, W, 3) uint8 RGB."""
        try:
            return self._env.render_ego()
        except Exception:
            return None

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        """Execute one command envelope against the MuJoCo simulation."""
        ok = True
        message = "ok"

        if cmd.command == "walk.set":
            self._walk.speed = int(cmd.payload.get("speed", 2))
            self._walk.height = float(cmd.payload.get("height", 0.036))
            self._walk.x = float(cmd.payload.get("x", 0.0))
            self._walk.y = float(cmd.payload.get("y", 0.0))
            self._walk.yaw = float(cmd.payload.get("yaw", 0.0))

        elif cmd.command == "walk.command":
            action = cmd.payload.get("action")
            if action == "start":
                self._walk.is_walking = True
            elif action == "stop":
                self._walk.is_walking = False
                self._walk.x = 0.0
                self._walk.y = 0.0
                self._walk.yaw = 0.0
            elif action == "enable":
                self._walk.enabled = True
            elif action == "disable":
                self._walk.enabled = False
                self._walk.is_walking = False
            else:
                ok = False
                message = f"unsupported walk.command action: {action}"

        elif cmd.command == "head.set":
            self._head.pan = float(cmd.payload.get("pan", 0.0))
            self._head.tilt = float(cmd.payload.get("tilt", 0.0))
            # Apply head targets to the sim actuators.
            head_targets = {
                "head_pan": self._head.pan,
                "head_tilt": self._head.tilt,
            }
            self._env.step(joint_targets=head_targets)
            self._last_telemetry = self._env._build_telemetry()

        elif cmd.command == "servo.set":
            # Accept both joint_positions (name->rad) and positions ([{id, pos}]).
            jp = cmd.payload.get("joint_positions", {})
            if isinstance(jp, dict) and jp:
                self._joint_positions.update(jp)
                self._last_telemetry = self._env.step(joint_targets=jp)
            else:
                # Fallback: decode id/position pairs.
                positions = cmd.payload.get("positions", [])
                if isinstance(positions, list) and positions:
                    try:
                        from eliza_robot.bridge.isaaclab.joint_map import (
                            servo_id_to_joint_name,
                            pulse_to_radians,
                        )
                        targets: dict[str, float] = {}
                        for item in positions:
                            if isinstance(item, dict) and "id" in item and "position" in item:
                                name = servo_id_to_joint_name(int(item["id"]))
                                targets[name] = pulse_to_radians(
                                    int(item["position"]), int(item["id"])
                                )
                        if targets:
                            self._joint_positions.update(targets)
                            self._last_telemetry = self._env.step(
                                joint_targets=targets
                            )
                    except ImportError:
                        ok = False
                        message = "joint_map import failed; provide joint_positions dict"

        elif cmd.command == "action.play":
            # No-op in sim: just acknowledge.
            pass

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
                "walk_enabled": self._walk.enabled,
                "is_walking": self._walk.is_walking,
            },
        )

    async def poll_events(self) -> list[EventEnvelope]:
        """Return simulated telemetry events from the MuJoCo state."""
        telemetry = self._last_telemetry or self._env._build_telemetry()

        basic = EventEnvelope(
            event="telemetry.basic",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "battery_mv": telemetry.get("battery_mv", 12400),
                "is_walking": self._walk.is_walking,
                "imu_roll": telemetry.get("imu_roll", 0.0),
                "imu_pitch": telemetry.get("imu_pitch", 0.0),
                "walk_x": self._walk.x,
                "walk_y": self._walk.y,
                "walk_yaw": self._walk.yaw,
                "walk_speed": self._walk.speed,
                "walk_height": self._walk.height,
                "head_pan": self._head.pan,
                "head_tilt": self._head.tilt,
                "joint_positions": telemetry.get("joint_positions", {}),
            },
        )

        # Build simulated perception event from target position.
        robot_pos = self._env.get_robot_position()
        target_pos = self._env.get_target_position()
        rel = target_pos - robot_pos
        distance = float(np.linalg.norm(rel[:2]))

        perception = EventEnvelope(
            event="telemetry.perception",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "entities": [
                    {
                        "entity_id": "sim-target-ball-01",
                        "label": "red ball",
                        "confidence": 0.99 if distance < 5.0 else 0.5,
                        "x": float(rel[0]),
                        "y": float(rel[1]),
                        "z": float(rel[2]),
                        "distance": distance,
                        "source": "mujoco",
                    }
                ],
            },
        )

        return [basic, perception]

    # ------------------------------------------------------------------
    # Extra API (not part of BridgeBackend but useful for demo scripts)
    # ------------------------------------------------------------------

    def render_frame(self) -> np.ndarray | None:
        """Render current ego camera frame (for perception pipeline).

        Returns (H, W, 3) uint8 RGB, or None if rendering fails.
        """
        try:
            return self._env.render_ego()
        except Exception:
            return None

    def get_telemetry(self) -> dict[str, Any]:
        """Return current MuJoCo sensor data in bridge telemetry format."""
        return self._last_telemetry or self._env._build_telemetry()
