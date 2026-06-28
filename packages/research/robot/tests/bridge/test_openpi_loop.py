"""Tests for the OpenPI autonomous policy loop."""

from __future__ import annotations

import asyncio
import unittest

import numpy as np

from eliza_robot.bridge.openpi_loop import OpenPIPolicyLoop
from eliza_robot.bridge.perception import PerceptionAggregator
from eliza_robot.bridge.openpi_adapter import AINEX_STATE_DIM, AINEX_ENTITY_SLOT_DIM
from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS


class TestPolicyLoopInit(unittest.TestCase):
    def test_init_without_perception(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        assert loop.pipeline is None
        assert loop.aggregator is not None
        assert not loop.is_running

    def test_init_with_perception(self):
        loop = OpenPIPolicyLoop(enable_perception=True)
        assert loop.pipeline is not None
        assert loop.aggregator is not None

    def test_aggregator_accessible(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        agg = loop.aggregator
        assert isinstance(agg, PerceptionAggregator)


class TestPolicyLoopObservation(unittest.TestCase):
    def test_get_observation_default(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        obs = loop.get_observation(task="walk forward")
        assert "state" in obs
        assert "prompt" in obs
        assert len(obs["state"]) == AINEX_STATE_DIM
        assert obs["prompt"] == "walk forward"

    def test_observation_entity_slots_zeros_without_pipeline(self):
        """Without perception pipeline, entity slots should be zeros."""
        loop = OpenPIPolicyLoop(enable_perception=False)
        obs = loop.get_observation()
        state = obs["state"]
        # Proprio is first 11, entity slots are 11:163
        entity_part = state[11:]
        assert len(entity_part) == AINEX_ENTITY_SLOT_DIM
        assert all(v == 0.0 for v in entity_part)

    def test_observation_with_telemetry(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        loop.update_telemetry({
            "battery_mv": 11500,
            "imu_roll": 0.1,
            "is_walking": True,
        })
        obs = loop.get_observation()
        state = obs["state"]
        # is_walking (index 9) should be 1.0
        self.assertAlmostEqual(state[9], 1.0)

    def test_observation_with_entity_slots(self):
        """Entity slots fed via aggregator should appear in observation."""
        loop = OpenPIPolicyLoop(enable_perception=False)
        # Manually set entity slots (as if pipeline was running)
        fake_slots = tuple([0.1] * TOTAL_ENTITY_DIMS)
        loop.aggregator.update_entity_slots(fake_slots)
        obs = loop.get_observation()
        entity_part = obs["state"][11:]
        assert all(abs(v - 0.1) < 0.001 for v in entity_part)


class TestPolicyLoopActions(unittest.TestCase):
    def test_process_named_action(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        commands = loop.process_action({
            "walk_x": 0.02,
            "walk_y": 0.0,
            "walk_yaw": 0.0,
            "walk_speed": 2,
            "walk_height": 0.036,
        })
        assert len(commands) >= 1
        assert commands[0]["command"] == "walk.set"
        self.assertAlmostEqual(commands[0]["payload"]["x"], 0.02)

    def test_process_vector_action(self):
        loop = OpenPIPolicyLoop(enable_perception=False)
        commands = loop.process_action({
            "action": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        })
        assert len(commands) >= 1
        assert commands[0]["command"] == "walk.set"


if __name__ == "__main__":
    unittest.main()
