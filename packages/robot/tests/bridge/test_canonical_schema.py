"""Tests for the shared AiNex canonical schema helpers."""

from __future__ import annotations

import unittest

from eliza_robot.schema.canonical import (
    AINEX_ENTITY_SLOT_DIM,
    AINEX_SCHEMA_VERSION,
    AINEX_STATE_DIM,
    adapt_state_vector,
    canonical_entity_slots,
)


class CanonicalSchemaTests(unittest.TestCase):
    def test_schema_version_present(self) -> None:
        self.assertTrue(AINEX_SCHEMA_VERSION.startswith("ainex-canonical-"))

    def test_entity_slots_padded_to_fixed_width(self) -> None:
        slots = canonical_entity_slots((1.0, -1.0))
        self.assertEqual(len(slots), AINEX_ENTITY_SLOT_DIM)
        self.assertEqual(slots[0], 1.0)
        self.assertEqual(slots[1], -1.0)
        self.assertTrue(all(value == 0.0 for value in slots[2:]))

    def test_state_vector_trimmed(self) -> None:
        state = adapt_state_vector(tuple(range(AINEX_STATE_DIM + 5)), AINEX_STATE_DIM)
        self.assertEqual(len(state), AINEX_STATE_DIM)
        self.assertEqual(state[0], 0.0)
        self.assertEqual(state[-1], float(AINEX_STATE_DIM - 1))

    def test_state_vector_padded(self) -> None:
        state = adapt_state_vector((0.5, 0.25), 5)
        self.assertEqual(state, (0.5, 0.25, 0.0, 0.0, 0.0))


if __name__ == "__main__":
    unittest.main()
