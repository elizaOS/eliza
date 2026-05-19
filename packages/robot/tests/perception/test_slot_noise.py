"""Tests for entity slot domain randomization noise."""

import jax
import jax.numpy as jp
import numpy as np
import pytest

from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
)
from eliza_robot.perception.entity_slots.slot_noise import apply_entity_slot_noise


def _make_test_slots() -> jax.Array:
    """Create a deterministic test entity slot tensor with 2 occupied slots."""
    slots = jp.zeros(TOTAL_ENTITY_DIMS)
    # Slot 0: PERSON at (0.5, 0.2, 0.1)
    slots = slots.at[TYPE_OFFSET + 1].set(1.0)  # PERSON one-hot
    slots = slots.at[POSITION_OFFSET].set(0.5)
    slots = slots.at[POSITION_OFFSET + 1].set(0.2)
    slots = slots.at[POSITION_OFFSET + 2].set(0.1)
    slots = slots.at[VELOCITY_OFFSET].set(0.0)
    slots = slots.at[VELOCITY_OFFSET + 1].set(0.0)
    slots = slots.at[VELOCITY_OFFSET + 2].set(0.0)
    slots = slots.at[SIZE_OFFSET].set(0.2)
    slots = slots.at[SIZE_OFFSET + 1].set(0.85)
    slots = slots.at[SIZE_OFFSET + 2].set(0.15)
    slots = slots.at[CONFIDENCE_OFFSET].set(1.0)
    slots = slots.at[RECENCY_OFFSET].set(0.0)
    slots = slots.at[BEARING_OFFSET].set(0.38)
    slots = slots.at[BEARING_OFFSET + 1].set(0.92)
    # Slot 1: OBJECT at (0.3, -0.1, 0.06)
    s1 = SLOT_DIM
    slots = slots.at[s1 + TYPE_OFFSET + 2].set(1.0)  # OBJECT one-hot
    slots = slots.at[s1 + POSITION_OFFSET].set(0.3)
    slots = slots.at[s1 + POSITION_OFFSET + 1].set(-0.1)
    slots = slots.at[s1 + POSITION_OFFSET + 2].set(0.06)
    slots = slots.at[s1 + SIZE_OFFSET].set(0.15)
    slots = slots.at[s1 + SIZE_OFFSET + 1].set(0.15)
    slots = slots.at[s1 + SIZE_OFFSET + 2].set(0.15)
    slots = slots.at[s1 + CONFIDENCE_OFFSET].set(1.0)
    slots = slots.at[s1 + RECENCY_OFFSET].set(0.0)
    slots = slots.at[s1 + BEARING_OFFSET].set(-0.32)
    slots = slots.at[s1 + BEARING_OFFSET + 1].set(0.95)
    return slots


class TestSlotNoiseShape:
    def test_output_shape(self):
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(0)
        noised = apply_entity_slot_noise(slots, rng)
        assert noised.shape == (TOTAL_ENTITY_DIMS,)

    def test_jit_compilable(self):
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(0)
        jitted = jax.jit(apply_entity_slot_noise)
        noised = jitted(slots, rng)
        assert noised.shape == (TOTAL_ENTITY_DIMS,)

    def test_all_zeros_stays_zeros(self):
        """Empty slots (no entities) should remain zero after noise."""
        slots = jp.zeros(TOTAL_ENTITY_DIMS)
        rng = jax.random.PRNGKey(42)
        noised = apply_entity_slot_noise(slots, rng)
        np.testing.assert_array_equal(np.array(noised), 0.0)


class TestSlotNoiseFields:
    def test_type_onehot_preserved(self):
        """Type one-hot encoding should not be modified by noise."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(1)
        noised = apply_entity_slot_noise(slots, rng, dropout_prob=0.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        # Slot 0 PERSON type
        type_vec = noised_2d[0, TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert float(type_vec[1]) == 1.0  # PERSON
        assert float(jp.sum(type_vec)) == 1.0
        # Slot 1 OBJECT type
        type_vec1 = noised_2d[1, TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert float(type_vec1[2]) == 1.0  # OBJECT

    def test_position_noised(self):
        """Position should differ from GT after noise."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(2)
        noised = apply_entity_slot_noise(slots, rng, dropout_prob=0.0)
        orig_pos = slots[POSITION_OFFSET:POSITION_OFFSET + 3]
        new_pos = noised[POSITION_OFFSET:POSITION_OFFSET + 3]
        # Should be different (with overwhelming probability)
        assert not jp.allclose(orig_pos, new_pos, atol=1e-6)

    def test_position_clipped(self):
        """Position should stay within [-1, 1] after noise."""
        slots = _make_test_slots()
        # Use extreme position near boundary
        slots = slots.at[POSITION_OFFSET].set(0.99)
        rng = jax.random.PRNGKey(3)
        noised = apply_entity_slot_noise(slots, rng, position_std=0.5, dropout_prob=0.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        pos = noised_2d[0, POSITION_OFFSET:POSITION_OFFSET + 3]
        assert jp.all(pos >= -1.0)
        assert jp.all(pos <= 1.0)

    def test_velocity_noised(self):
        """Velocity should get noise even when GT is zero."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(4)
        noised = apply_entity_slot_noise(slots, rng, dropout_prob=0.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        vel = noised_2d[0, VELOCITY_OFFSET:VELOCITY_OFFSET + 3]
        # GT velocity was 0, noise should make it non-zero
        assert jp.any(jp.abs(vel) > 0.001)

    def test_confidence_randomized(self):
        """Confidence should be in [0.3, 1.0], not the GT value of 1.0."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(5)
        # Run many times to check range
        confs = []
        for i in range(50):
            r = jax.random.PRNGKey(i + 100)
            noised = apply_entity_slot_noise(slots, r, dropout_prob=0.0)
            noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
            confs.append(float(noised_2d[0, CONFIDENCE_OFFSET]))
        confs = np.array(confs)
        assert np.all(confs >= 0.3 - 0.01)
        assert np.all(confs <= 1.0 + 0.01)
        # Should have variation (not all 1.0)
        assert np.std(confs) > 0.01

    def test_recency_randomized(self):
        """Recency should be in [0.0, 0.2], not the GT value of 0.0."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(6)
        recs = []
        for i in range(50):
            r = jax.random.PRNGKey(i + 200)
            noised = apply_entity_slot_noise(slots, r, dropout_prob=0.0)
            noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
            recs.append(float(noised_2d[0, RECENCY_OFFSET]))
        recs = np.array(recs)
        assert np.all(recs >= -0.01)
        assert np.all(recs <= 0.21)
        assert np.mean(recs) > 0.01

    def test_size_stays_nonnegative(self):
        """Size should remain >= 0 after noise."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(7)
        noised = apply_entity_slot_noise(slots, rng, size_std=0.3, dropout_prob=0.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        sz = noised_2d[0, SIZE_OFFSET:SIZE_OFFSET + 3]
        assert jp.all(sz >= 0.0)


class TestSlotNoiseDropout:
    def test_dropout_can_zero_slot(self):
        """With high dropout probability, some slots should be zeroed."""
        slots = _make_test_slots()
        # Use 100% dropout
        rng = jax.random.PRNGKey(10)
        noised = apply_entity_slot_noise(slots, rng, dropout_prob=1.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        # Active slots should be zeroed
        assert float(jp.sum(jp.abs(noised_2d[0]))) == 0.0
        assert float(jp.sum(jp.abs(noised_2d[1]))) == 0.0

    def test_zero_dropout_preserves_slots(self):
        """With 0% dropout, active slots should remain non-zero."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(11)
        noised = apply_entity_slot_noise(slots, rng, dropout_prob=0.0)
        noised_2d = noised.reshape(NUM_ENTITY_SLOTS, SLOT_DIM)
        assert float(jp.sum(jp.abs(noised_2d[0]))) > 0.0
        assert float(jp.sum(jp.abs(noised_2d[1]))) > 0.0


class TestSlotNoiseDeterminism:
    def test_same_rng_same_result(self):
        """Same RNG key should produce identical noise."""
        slots = _make_test_slots()
        rng = jax.random.PRNGKey(99)
        n1 = apply_entity_slot_noise(slots, rng)
        n2 = apply_entity_slot_noise(slots, rng)
        np.testing.assert_array_equal(np.array(n1), np.array(n2))

    def test_different_rng_different_result(self):
        """Different RNG keys should produce different noise."""
        slots = _make_test_slots()
        n1 = apply_entity_slot_noise(slots, jax.random.PRNGKey(0), dropout_prob=0.0)
        n2 = apply_entity_slot_noise(slots, jax.random.PRNGKey(1), dropout_prob=0.0)
        assert not jp.allclose(n1, n2, atol=1e-6)
