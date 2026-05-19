"""Helpers for deriving canonical bridge observations/actions from MuJoCo rollouts."""

from __future__ import annotations

import math

import jax.numpy as jp
import numpy as np

from bridge.openpi_adapter import build_observation
from eliza_robot.interfaces import AinexPerceptionObservation
from eliza_robot.schema.canonical import (
    AINEX_SCHEMA_VERSION,
    WALK_SPEED_MAX,
    WALK_SPEED_MIN,
    WALK_X_RANGE,
    WALK_Y_RANGE,
    WALK_YAW_RANGE,
)


def velocity_to_stride(velocity_mps: float, ctrl_dt: float) -> float:
    """Convert a velocity command (m/s) into an approximate stride delta per step."""
    stride = velocity_mps * ctrl_dt
    return float(np.clip(stride, -WALK_X_RANGE, WALK_X_RANGE))


def yaw_rate_to_step_deg(yaw_rate_rad_s: float, ctrl_dt: float) -> float:
    """Convert yaw rate (rad/s) into an approximate degrees-per-step command."""
    yaw_deg = math.degrees(yaw_rate_rad_s * ctrl_dt)
    return float(np.clip(yaw_deg, -WALK_YAW_RANGE, WALK_YAW_RANGE))


def command_to_bridge_action(command: np.ndarray, ctrl_dt: float) -> list[float]:
    """Map MuJoCo joystick command [vx, vy, vyaw] to bridge command targets."""
    vx = velocity_to_stride(float(command[0]), ctrl_dt)
    vy = velocity_to_stride(float(command[1]), ctrl_dt)
    yaw = yaw_rate_to_step_deg(float(command[2]), ctrl_dt)
    planar_speed = math.sqrt(float(command[0]) ** 2 + float(command[1]) ** 2)
    speed_scale = min(1.0, planar_speed / 0.3)
    walk_speed = int(round(WALK_SPEED_MIN + speed_scale * (WALK_SPEED_MAX - WALK_SPEED_MIN)))
    walk_speed = max(WALK_SPEED_MIN, min(WALK_SPEED_MAX, walk_speed))
    return [
        vx,
        vy,
        yaw,
        0.036,
        float(walk_speed),
        0.0,
        0.0,
    ]


def state_to_bridge_observation(env, state) -> AinexPerceptionObservation:
    """Convert a MuJoCo joystick state into the canonical bridge observation."""
    local_vel = np.asarray(env.get_local_linvel(state.data))
    gyro = np.asarray(env.get_gyro(state.data))
    gravity = np.asarray(env.get_gravity(state.data))
    command = np.asarray(state.info["command"])
    torso_z = float(np.asarray(state.data.xpos[env._torso_body_id, 2]))

    imu_roll = float(np.arcsin(np.clip(gravity[0], -1.0, 1.0)))
    imu_pitch = float(np.arcsin(np.clip(gravity[1], -1.0, 1.0)))
    is_walking = bool(np.linalg.norm(command[:2]) > 0.01 or abs(command[2]) > 0.01)
    walk_speed = int(command_to_bridge_action(command, env._config.ctrl_dt)[4])

    return AinexPerceptionObservation(
        timestamp=float(state.info["step"]),
        battery_mv=12000,
        imu_roll=imu_roll,
        imu_pitch=imu_pitch,
        is_walking=is_walking,
        walk_x=velocity_to_stride(float(local_vel[0]), env._config.ctrl_dt),
        walk_y=velocity_to_stride(float(local_vel[1]), env._config.ctrl_dt),
        walk_yaw=yaw_rate_to_step_deg(float(gyro[2]), env._config.ctrl_dt),
        walk_height=max(0.015, min(0.06, torso_z * 0.145)),
        walk_speed=walk_speed,
        head_pan=0.0,
        head_tilt=0.0,
        entity_slots=(),
        camera_frame="",
        language_instruction="walk forward",
        schema_version=AINEX_SCHEMA_VERSION,
    )


def state_to_bridge_state_vector(env, state) -> np.ndarray:
    """Convert a MuJoCo state into the canonical 163-D bridge observation vector."""
    obs = build_observation(state_to_bridge_observation(env, state))
    return np.asarray(obs.state, dtype=np.float32)
