"""Shared simulation state for IsaacLab backends.

Provides a deterministic in-memory robot state that can be driven by either
the command-envelope backend or the ROSBridge backend. When the IsaacLab
runtime is available, this state is synchronized with the actual simulation;
when not, it acts as a self-contained physics surrogate.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from random import random

from eliza_robot.bridge.isaaclab.joint_map import JOINT_BY_SERVO_ID, JOINT_NAMES, NUM_JOINTS, radians_to_pulse
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
class HeadState:
    pan: float = 0.0
    tilt: float = 0.0


@dataclass
class SimRobotState:
    """Full simulated robot state."""

    walk: WalkState = field(default_factory=WalkState)
    head: HeadState = field(default_factory=HeadState)
    battery_mv: int = 12400
    last_action: str = "stand"
    joint_positions_rad: dict[str, float] = field(default_factory=dict)
    imu_orientation: dict[str, float] = field(default_factory=lambda: {
        "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0,
    })
    sim_time: float = 0.0
    ready: bool = False

    def __post_init__(self) -> None:
        if not self.joint_positions_rad:
            self.joint_positions_rad = {name: 0.0 for name in JOINT_NAMES}

    def tick(self, dt: float = 0.02) -> None:
        """Advance simulation state by one timestep."""
        self.sim_time += dt

        # Simulate battery drain.
        if self.walk.is_walking:
            self.battery_mv = max(10400, self.battery_mv - int(1 + 3 * random()))
        else:
            self.battery_mv = max(10400, self.battery_mv - int(random()))

        # Simulate IMU changes when walking.
        if self.walk.is_walking:
            yaw = self.walk.angle * (math.pi / 180.0)
            # Add small oscillation to simulate walking dynamics.
            roll_osc = 0.02 * math.sin(self.sim_time * 8.0)
            pitch_osc = 0.01 * math.sin(self.sim_time * 16.0)
            half_yaw = yaw / 2.0
            self.imu_orientation = {
                "x": pitch_osc,
                "y": roll_osc,
                "z": math.sin(half_yaw),
                "w": math.cos(half_yaw),
            }
        else:
            self.imu_orientation = {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}

    def apply_walk_params(self, speed: int, height: float, x: float, y: float, angle: float) -> None:
        self.walk.speed = speed
        self.walk.height = height
        self.walk.x = x
        self.walk.y = y
        self.walk.angle = angle

    def apply_walk_command(self, action: str) -> bool:
        if action == "start":
            if self.walk.enabled:
                self.walk.is_walking = True
            return True
        if action == "stop":
            self.walk.is_walking = False
            return True
        if action == "enable":
            self.walk.enabled = True
            return True
        if action == "disable":
            self.walk.enabled = False
            self.walk.is_walking = False
            return True
        if action in {"enable_control", "disable_control"}:
            return True
        return False

    def apply_head(self, pan: float | None = None, tilt: float | None = None) -> None:
        if pan is not None:
            self.head.pan = pan
        if tilt is not None:
            self.head.tilt = tilt

    def apply_action(self, name: str) -> None:
        self.last_action = name
        self.walk.is_walking = False

    def get_servo_position(self, servo_id: int) -> int:
        """Get servo position in pulse-width units (0-1000)."""
        spec = JOINT_BY_SERVO_ID.get(servo_id)
        if spec is None:
            return 500  # center
        rad = self.joint_positions_rad.get(spec.urdf_name, 0.0)
        return radians_to_pulse(rad, servo_id)

    def snapshot_telemetry(self) -> dict[str, JsonDict]:
        """Return current telemetry as a ROSBridge topic snapshot."""
        return {
            "/walking/is_walking": {"data": self.walk.is_walking},
            "/ros_robot_controller/battery": {"data": self.battery_mv},
            "/imu": {"orientation": dict(self.imu_orientation)},
            "/bridge/state": {
                "walk": {
                    "enabled": self.walk.enabled,
                    "speed": self.walk.speed,
                    "height": self.walk.height,
                    "x": self.walk.x,
                    "y": self.walk.y,
                    "angle": self.walk.angle,
                    "is_walking": self.walk.is_walking,
                },
                "head": {"pan": self.head.pan, "tilt": self.head.tilt},
                "last_action": self.last_action,
            },
        }
