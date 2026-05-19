"""SimEntitySlotProvider: Ground-truth entity slots from MuJoCo state.

Produces (152,) entity slot tensors directly from MuJoCo body positions,
without needing camera rendering. JAX-compatible for JIT compilation
in training loops.
"""

from __future__ import annotations

from typing import Any

import jax
import jax.numpy as jp
import numpy as np

from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    MAX_DISTANCE,
    MAX_SIZE,
    MAX_VELOCITY,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
    EntityType,
)


def sim_entity_slots_jax(
    robot_pos: jax.Array,           # (3,) robot world position
    robot_yaw: jax.Array,           # scalar yaw angle
    entity_positions: jax.Array,    # (N, 3) world positions of entities
    entity_types: jax.Array,        # (N,) int entity type indices
    entity_sizes: jax.Array,        # (N, 3) whd sizes
    entity_velocities: jax.Array | None = None,  # (N, 3) world velocities
    entity_mask: jax.Array | None = None,  # (N,) bool — True for active entities
    num_slots: int = NUM_ENTITY_SLOTS,
) -> jax.Array:
    """Produce entity slots from ground-truth MuJoCo data (JAX/JIT-compatible).

    All positions are transformed to robot-egocentric frame.
    Returns flat (num_slots * SLOT_DIM,) array.

    Args:
        entity_mask: Optional boolean mask. If provided, only True entries
            are considered active entities. Masked entries produce zero slots.
            If None, all entries are treated as active.
    """
    n_entities = entity_positions.shape[0]
    if n_entities == 0:
        return jp.zeros(num_slots * SLOT_DIM)
    if entity_velocities is None:
        entity_velocities = jp.zeros_like(entity_positions)
    if entity_mask is None:
        entity_mask = jp.ones(n_entities, dtype=jp.bool_)

    # Transform positions to robot frame
    cos_yaw = jp.cos(-robot_yaw)
    sin_yaw = jp.sin(-robot_yaw)
    rot = jp.array([
        [cos_yaw, -sin_yaw, 0],
        [sin_yaw, cos_yaw, 0],
        [0, 0, 1],
    ])
    rel_pos = entity_positions - robot_pos[None, :]
    local_pos = (rot @ rel_pos.T).T  # (N, 3)
    local_vel = (rot @ entity_velocities.T).T

    # Compute 3D distances for sorting (matching real encoder which uses entity.distance)
    dists = jp.linalg.norm(local_pos, axis=1)

    # Sort by type (persons first) then distance
    # Persons get priority via large negative offset
    # Masked (inactive) entities get pushed to the end with large positive sort key
    sort_key = (
        dists
        - (entity_types == EntityType.PERSON) * 1000.0
        + (~entity_mask) * 10000.0
    )
    sorted_indices = jp.argsort(sort_key)

    # Build slots
    def encode_slot(idx: jax.Array) -> jax.Array:
        slot = jp.zeros(SLOT_DIM)
        # Bounds check: if idx >= n_entities, return zeros
        valid = idx < n_entities
        i = jp.where(valid, sorted_indices[jp.clip(idx, 0, n_entities - 1)], 0)

        # Check if this entity is active (not masked out)
        active = valid & entity_mask[i]

        pos = local_pos[i]
        vel = local_vel[i]
        sz = entity_sizes[i]
        etype = entity_types[i]

        # One-hot type
        type_onehot = jp.zeros(NUM_ENTITY_TYPES).at[etype].set(1.0)
        slot = slot.at[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES].set(type_onehot)

        # Position normalized
        norm_pos = jp.clip(pos / MAX_DISTANCE, -1.0, 1.0)
        slot = slot.at[POSITION_OFFSET:POSITION_OFFSET + 3].set(norm_pos)

        # Velocity normalized
        norm_vel = jp.clip(vel / MAX_VELOCITY, -1.0, 1.0)
        slot = slot.at[VELOCITY_OFFSET:VELOCITY_OFFSET + 3].set(norm_vel)

        # Size normalized
        norm_sz = jp.clip(sz / MAX_SIZE, 0.0, 1.0)
        slot = slot.at[SIZE_OFFSET:SIZE_OFFSET + 3].set(norm_sz)

        # Confidence = 1.0 for GT
        slot = slot.at[CONFIDENCE_OFFSET].set(1.0)

        # Recency = 0.0 for current frame
        slot = slot.at[RECENCY_OFFSET].set(0.0)

        # Bearing
        bearing = jp.arctan2(pos[1], pos[0])
        slot = slot.at[BEARING_OFFSET].set(jp.sin(bearing))
        slot = slot.at[BEARING_OFFSET + 1].set(jp.cos(bearing))

        # Zero out if invalid or masked
        slot = jp.where(active, slot, jp.zeros(SLOT_DIM))
        return slot

    slot_indices = jp.arange(num_slots)
    slots = jax.vmap(encode_slot)(slot_indices)
    return slots.flatten()


def empty_entity_slots(num_slots: int = NUM_ENTITY_SLOTS) -> jax.Array:
    """Return zero-filled entity slots (no entities present)."""
    return jp.zeros(num_slots * SLOT_DIM)
