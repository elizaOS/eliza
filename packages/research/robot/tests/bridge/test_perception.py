"""Tests for the perception aggregator."""

from __future__ import annotations

import time
import unittest

from eliza_robot.bridge.perception import PerceptionAggregator
from eliza_robot.schema.canonical import AINEX_ENTITY_SLOT_DIM, AINEX_SCHEMA_VERSION


class PerceptionAggregatorTests(unittest.TestCase):
    """Test perception entity tracking and scene snapshot."""

    def test_empty_snapshot(self) -> None:
        agg = PerceptionAggregator()
        snap = agg.snapshot()
        self.assertEqual(len(snap.tracked_entities), 0)
        self.assertFalse(snap.is_walking)
        self.assertEqual(snap.schema_version, AINEX_SCHEMA_VERSION)

    def test_update_entity(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entity("obj1", "cup", confidence=0.9, x=0.5, y=0.1, z=1.0)
        snap = agg.snapshot()
        self.assertEqual(len(snap.tracked_entities), 1)
        self.assertEqual(snap.tracked_entities[0].label, "cup")

    def test_entity_pruned_after_timeout(self) -> None:
        agg = PerceptionAggregator(stale_timeout_sec=0.01)
        agg.update_entity("obj1", "cup", confidence=0.9)
        time.sleep(0.02)
        snap = agg.snapshot()
        self.assertEqual(len(snap.tracked_entities), 0)

    def test_update_telemetry(self) -> None:
        agg = PerceptionAggregator()
        agg.update_telemetry({
            "battery_mv": 11500,
            "is_walking": True,
            "walk_x": 0.02,
            "head_pan": 0.5,
        })
        snap = agg.snapshot()
        self.assertEqual(snap.battery_mv, 11500)
        self.assertTrue(snap.is_walking)
        self.assertAlmostEqual(snap.walk_x, 0.02)
        self.assertAlmostEqual(snap.head_pan, 0.5)

    def test_scene_summary(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entity("obj1", "cup", confidence=0.9, x=0.5, y=0.1, z=1.0)
        agg.update_entity("face1", "person", confidence=0.8, source="face")
        summary = agg.scene_summary()
        self.assertEqual(summary["entity_count"], 2)
        self.assertIn("robot", summary)
        self.assertIn("entities", summary)

    def test_max_entities_enforced(self) -> None:
        agg = PerceptionAggregator(max_entities=3)
        for i in range(10):
            agg.update_entity(f"obj{i}", f"item{i}", confidence=float(i) / 10.0)
        snap = agg.snapshot()
        self.assertLessEqual(len(snap.tracked_entities), 3)

    def test_batch_update(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entities_batch([
            {"entity_id": "a", "label": "ball", "confidence": 0.7},
            {"entity_id": "b", "label": "box", "confidence": 0.5},
        ])
        snap = agg.snapshot()
        self.assertEqual(len(snap.tracked_entities), 2)

    def test_remove_entity(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entity("obj1", "cup", confidence=0.9)
        agg.remove_entity("obj1")
        snap = agg.snapshot()
        self.assertEqual(len(snap.tracked_entities), 0)

    def test_language_instruction_passthrough(self) -> None:
        agg = PerceptionAggregator()
        snap = agg.snapshot(language_instruction="pick up the cup")
        self.assertEqual(snap.language_instruction, "pick up the cup")

    def test_entity_slots_are_canonicalized(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entity_slots((0.25, 0.5))
        snap = agg.snapshot()
        self.assertEqual(len(snap.entity_slots), AINEX_ENTITY_SLOT_DIM)
        self.assertAlmostEqual(snap.entity_slots[0], 0.25)
        self.assertAlmostEqual(snap.entity_slots[1], 0.5)
        self.assertTrue(all(v == 0.0 for v in snap.entity_slots[2:]))

    def test_scene_summary_includes_mock_entity_shape(self) -> None:
        agg = PerceptionAggregator()
        agg.update_entities_batch(
            [
                {
                    "entity_id": "mock-red-ball-01",
                    "label": "red ball",
                    "confidence": 0.98,
                    "x": 0.0,
                    "y": 0.0,
                    "z": 0.4,
                    "source": "mock",
                }
            ]
        )
        summary = agg.scene_summary()
        self.assertEqual(summary["entity_count"], 1)
        self.assertEqual(summary["entities"][0]["label"], "red ball")


if __name__ == "__main__":
    unittest.main()
