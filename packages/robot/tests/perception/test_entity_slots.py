"""Tests for entity slot encoder module."""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    MAX_DISTANCE,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    EntityType,
)
from eliza_robot.perception.entity_slots.slot_encoder import decode_entity_type, encode_entity_slots
from eliza_robot.perception.world_model.entity import PersistentEntity


def _make_entity(
    eid: str,
    etype: EntityType = EntityType.PERSON,
    pos: tuple[float, float, float] = (1.0, 0.0, 0.0),
    confidence: float = 0.9,
) -> PersistentEntity:
    e = PersistentEntity(entity_id=eid, entity_type=etype)
    e.position = np.array(pos, dtype=np.float32)
    e.confidence = confidence
    e.last_seen = time.monotonic()
    e.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)
    return e


class TestEntitySlotEncoder:
    def test_zero_for_empty(self):
        slots = encode_entity_slots([])
        assert slots.shape == (TOTAL_ENTITY_DIMS,)
        assert np.allclose(slots, 0.0)

    def test_single_person_fills_slot(self):
        entity = _make_entity("p0", EntityType.PERSON, (2.0, 1.0, 0.5))
        slots = encode_entity_slots([entity])
        assert slots.shape == (TOTAL_ENTITY_DIMS,)
        # First slot should have non-zero values
        first_slot = slots[:SLOT_DIM]
        assert not np.allclose(first_slot, 0.0)
        # Second slot should be zero
        second_slot = slots[SLOT_DIM:2 * SLOT_DIM]
        assert np.allclose(second_slot, 0.0)

    def test_output_dim_152(self):
        assert TOTAL_ENTITY_DIMS == 152
        slots = encode_entity_slots([])
        assert slots.shape == (152,)

    def test_one_hot_encoding(self):
        entity = _make_entity("p0", EntityType.PERSON)
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        type_vec = first_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_vec[EntityType.PERSON] == 1.0
        assert sum(type_vec) == 1.0

    def test_position_normalization(self):
        # Position at MAX_DISTANCE should normalize to 1.0
        entity = _make_entity("p0", EntityType.PERSON, (MAX_DISTANCE, 0, 0))
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        pos = first_slot[POSITION_OFFSET:POSITION_OFFSET + 3]
        assert abs(pos[0] - 1.0) < 0.01
        assert abs(pos[1]) < 0.01

    def test_position_clipped(self):
        # Position beyond MAX_DISTANCE should be clipped to 1.0
        entity = _make_entity("p0", EntityType.PERSON, (10.0, 0, 0))
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        pos = first_slot[POSITION_OFFSET:POSITION_OFFSET + 3]
        assert pos[0] == 1.0

    def test_persons_first_sorting(self):
        person = _make_entity("p0", EntityType.PERSON, (3.0, 0, 0))
        obj = _make_entity("o0", EntityType.OBJECT, (1.0, 0, 0))
        # Object is closer but person should come first
        slots = encode_entity_slots([obj, person])
        first_slot = slots[:SLOT_DIM]
        type_vec = first_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_vec[EntityType.PERSON] == 1.0

    def test_overflow_drops_lowest_priority(self):
        entities = [_make_entity(f"e{i}", EntityType.OBJECT, (float(i + 1), 0, 0))
                    for i in range(12)]
        slots = encode_entity_slots(entities)
        # Should only have NUM_ENTITY_SLOTS entities
        active_slots = 0
        for i in range(NUM_ENTITY_SLOTS):
            s = slots[i * SLOT_DIM:(i + 1) * SLOT_DIM]
            if not np.allclose(s, 0.0):
                active_slots += 1
        assert active_slots == NUM_ENTITY_SLOTS

    def test_bearing_matches_arctan2(self):
        entity = _make_entity("p0", EntityType.PERSON, (1.0, 1.0, 0.0))
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        sin_b = first_slot[BEARING_OFFSET]
        cos_b = first_slot[BEARING_OFFSET + 1]
        expected_angle = np.arctan2(1.0, 1.0)
        np.testing.assert_allclose(sin_b, np.sin(expected_angle), atol=0.01)
        np.testing.assert_allclose(cos_b, np.cos(expected_angle), atol=0.01)

    def test_confidence_in_range(self):
        entity = _make_entity("p0", EntityType.PERSON, confidence=0.75)
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        assert 0.0 <= first_slot[CONFIDENCE_OFFSET] <= 1.0
        assert abs(first_slot[CONFIDENCE_OFFSET] - 0.75) < 0.01

    def test_decode_entity_type(self):
        entity = _make_entity("p0", EntityType.FURNITURE)
        slots = encode_entity_slots([entity])
        first_slot = slots[:SLOT_DIM]
        decoded = decode_entity_type(first_slot)
        assert decoded == EntityType.FURNITURE
