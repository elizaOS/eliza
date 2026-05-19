"""Canonical AiNex observation and control schema.

This module centralizes the dimensions, ranges, and lightweight helpers that
are shared by the bridge, OpenPI adapters, and MuJoCo-facing runtime code.
"""

from __future__ import annotations

from collections.abc import Sequence
import math

from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS

AINEX_SCHEMA_VERSION = "ainex-canonical-v1"

# Observation dimensions
AINEX_PROPRIO_DIM = 11
AINEX_ENTITY_SLOT_DIM = TOTAL_ENTITY_DIMS
AINEX_STATE_DIM = AINEX_PROPRIO_DIM + AINEX_ENTITY_SLOT_DIM

# Action dimensions
AINEX_ACTION_DIM = 7

# State layout names
AINEX_PROPRIO_FIELDS: tuple[str, ...] = (
    "walk_x",
    "walk_y",
    "walk_yaw",
    "walk_height",
    "walk_speed",
    "head_pan",
    "head_tilt",
    "imu_roll",
    "imu_pitch",
    "is_walking",
    "battery_mv",
)

# Control / normalization ranges
WALK_X_RANGE = 0.05
WALK_Y_RANGE = 0.05
WALK_YAW_RANGE = 10.0
WALK_HEIGHT_MIN = 0.015
WALK_HEIGHT_MAX = 0.06
WALK_SPEED_MIN = 1
WALK_SPEED_MAX = 4
HEAD_PAN_RANGE = 1.5
HEAD_TILT_RANGE = 1.0
IMU_RANGE = math.pi
BATTERY_MIN = 10400
BATTERY_MAX = 12600


def normalize_value(value: float, lo: float, hi: float) -> float:
    """Normalize a scalar from [lo, hi] into [-1, 1]."""
    if hi == lo:
        return 0.0
    return 2.0 * (value - lo) / (hi - lo) - 1.0


def denormalize_value(value: float, lo: float, hi: float) -> float:
    """Map a normalized scalar from [-1, 1] back into [lo, hi]."""
    return lo + (value + 1.0) * 0.5 * (hi - lo)


def clamp_value(value: float, lo: float, hi: float) -> float:
    """Clamp a scalar into [lo, hi]."""
    return max(lo, min(hi, value))


def canonical_entity_slots(values: Sequence[float]) -> tuple[float, ...]:
    """Return a fixed-width entity-slot tuple, padding or truncating as needed."""
    if len(values) == AINEX_ENTITY_SLOT_DIM:
        return tuple(float(v) for v in values)

    padded = [0.0] * AINEX_ENTITY_SLOT_DIM
    limit = min(len(values), AINEX_ENTITY_SLOT_DIM)
    for index in range(limit):
        padded[index] = float(values[index])
    return tuple(padded)


def adapt_state_vector(values: Sequence[float], target_dim: int) -> tuple[float, ...]:
    """Pad or trim a state vector to the target dimension.

    This intentionally preserves the prefix of the canonical state and pads the
    remainder with zeros. It is suitable for smoke-test compatibility and
    baseline deployment where the policy expects fewer or more dimensions than
    the canonical bridge state exposes.
    """
    if target_dim <= 0:
        return ()

    if len(values) == target_dim:
        return tuple(float(v) for v in values)

    adapted = [0.0] * target_dim
    limit = min(len(values), target_dim)
    for index in range(limit):
        adapted[index] = float(values[index])
    return tuple(adapted)
