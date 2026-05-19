"""Entity slot encoder: WorldState -> fixed (NUM_SLOTS, SLOT_DIM) tensor.

Produces a flat (152,) array suitable for RL policy observations.
Persons are prioritized, then objects sorted by distance.
"""

from __future__ import annotations

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
    RECENCY_HORIZON,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
    EntityType,
)
from eliza_robot.perception.world_model.entity import PersistentEntity


def encode_entity_slots(
    entities: list[PersistentEntity],
    num_slots: int = NUM_ENTITY_SLOTS,
) -> np.ndarray:
    """Encode entities into a flat (num_slots * SLOT_DIM,) observation vector.

    Priority: persons first (by distance), then other entities (by distance).
    Empty slots are zero-filled.
    """
    # Sort: persons first, then by distance ascending
    persons = [e for e in entities if e.entity_type == EntityType.PERSON]
    others = [e for e in entities if e.entity_type != EntityType.PERSON]
    persons.sort(key=lambda e: e.distance)
    others.sort(key=lambda e: e.distance)
    sorted_entities = persons + others

    slots = np.zeros((num_slots, SLOT_DIM), dtype=np.float32)
    for i, entity in enumerate(sorted_entities[:num_slots]):
        slots[i] = _encode_single_slot(entity)

    return slots.flatten()


def _encode_single_slot(entity: PersistentEntity) -> np.ndarray:
    """Encode a single entity into a (SLOT_DIM,) vector."""
    slot = np.zeros(SLOT_DIM, dtype=np.float32)

    # One-hot entity type (6 dims)
    type_idx = int(entity.entity_type)
    if 0 <= type_idx < NUM_ENTITY_TYPES:
        slot[TYPE_OFFSET + type_idx] = 1.0

    # Position xyz normalized to [-1, 1]
    pos = np.clip(entity.position / MAX_DISTANCE, -1.0, 1.0)
    slot[POSITION_OFFSET:POSITION_OFFSET + 3] = pos

    # Velocity xyz normalized to [-1, 1]
    vel = np.clip(entity.velocity / MAX_VELOCITY, -1.0, 1.0)
    slot[VELOCITY_OFFSET:VELOCITY_OFFSET + 3] = vel

    # Size whd normalized to [0, 1]
    sz = np.clip(entity.size / MAX_SIZE, 0.0, 1.0)
    slot[SIZE_OFFSET:SIZE_OFFSET + 3] = sz

    # Confidence [0, 1]
    slot[CONFIDENCE_OFFSET] = np.clip(entity.confidence, 0.0, 1.0)

    # Recency (seconds since seen / horizon), clamped [0, 1]
    slot[RECENCY_OFFSET] = np.clip(entity.age_sec / RECENCY_HORIZON, 0.0, 1.0)

    # Bearing (sin, cos of angle in x-y plane)
    bearing = entity.bearing_rad
    slot[BEARING_OFFSET] = np.sin(bearing)
    slot[BEARING_OFFSET + 1] = np.cos(bearing)

    return slot


def decode_entity_type(slot: np.ndarray) -> EntityType:
    """Decode entity type from one-hot in a slot vector."""
    type_vec = slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
    idx = int(np.argmax(type_vec))
    if type_vec[idx] < 0.5:
        return EntityType.UNKNOWN
    return EntityType(idx)
