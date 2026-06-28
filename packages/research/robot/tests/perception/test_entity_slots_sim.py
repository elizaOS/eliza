"""Tests for sim entity slot provider."""

from __future__ import annotations

import numpy as np
import pytest

jax = pytest.importorskip("jax")
import jax.numpy as jp

from eliza_robot.perception.entity_slots.sim_provider import empty_entity_slots, sim_entity_slots_jax
from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    EntityType,
)


class TestSimEntitySlotProvider:
    def test_empty_slots_shape(self):
        slots = empty_entity_slots()
        assert slots.shape == (TOTAL_ENTITY_DIMS,)
        assert jp.allclose(slots, 0.0)

    def test_single_entity(self):
        robot_pos = jp.array([0.0, 0.0, 0.0])
        robot_yaw = jp.float32(0.0)
        entity_pos = jp.array([[2.0, 1.0, 0.0]])
        entity_types = jp.array([EntityType.PERSON])
        entity_sizes = jp.array([[0.5, 1.7, 0.3]])

        slots = sim_entity_slots_jax(
            robot_pos, robot_yaw, entity_pos, entity_types, entity_sizes
        )
        assert slots.shape == (TOTAL_ENTITY_DIMS,)

        # First slot should be non-zero
        first_slot = slots[:SLOT_DIM]
        assert not jp.allclose(first_slot, 0.0)

        # Type should be PERSON
        type_vec = first_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_vec[EntityType.PERSON] == 1.0

        # Confidence should be 1.0 (GT)
        assert first_slot[CONFIDENCE_OFFSET] == 1.0

    def test_multiple_entities(self):
        robot_pos = jp.array([0.0, 0.0, 0.0])
        robot_yaw = jp.float32(0.0)
        entity_pos = jp.array([
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
        ])
        entity_types = jp.array([EntityType.OBJECT, EntityType.PERSON, EntityType.FURNITURE])
        entity_sizes = jp.ones((3, 3)) * 0.5

        slots = sim_entity_slots_jax(
            robot_pos, robot_yaw, entity_pos, entity_types, entity_sizes
        )
        assert slots.shape == (TOTAL_ENTITY_DIMS,)

        # First slot should be PERSON (priority sorting)
        first_slot = slots[:SLOT_DIM]
        type_vec = first_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_vec[EntityType.PERSON] == 1.0

    def test_output_matches_encoder_format(self):
        """Verify sim output has same shape as real encoder."""
        from eliza_robot.perception.entity_slots.slot_encoder import encode_entity_slots

        real_slots = encode_entity_slots([])
        sim_slots = empty_entity_slots()
        assert real_slots.shape == sim_slots.shape

    def test_jit_compilable(self):
        """Verify the sim provider JIT-compiles without error."""
        @jax.jit
        def compute_slots():
            return sim_entity_slots_jax(
                jp.zeros(3),
                jp.float32(0.0),
                jp.array([[1.0, 0.0, 0.0]]),
                jp.array([1]),
                jp.ones((1, 3)),
            )

        result = compute_slots()
        assert result.shape == (TOTAL_ENTITY_DIMS,)

    def test_robot_frame_transform(self):
        """Entity behind robot should have negative x in robot frame."""
        robot_pos = jp.array([0.0, 0.0, 0.0])
        robot_yaw = jp.float32(0.0)
        # Entity behind robot (negative x in world)
        entity_pos = jp.array([[-1.0, 0.0, 0.0]])
        entity_types = jp.array([EntityType.OBJECT])
        entity_sizes = jp.ones((1, 3))

        slots = sim_entity_slots_jax(
            robot_pos, robot_yaw, entity_pos, entity_types, entity_sizes
        )
        first_slot = slots[:SLOT_DIM]
        x_norm = first_slot[POSITION_OFFSET]
        assert x_norm < 0  # negative x = behind
