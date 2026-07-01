"""Tests for the OpenPI adapter observation/action mappings."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.openpi_adapter import (
    AINEX_ACTION_DIM,
    AINEX_STATE_DIM,
    action_to_bridge_commands,
    build_observation,
    decode_action,
    default_perception,
    observation_to_dict,
)
from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION
from eliza_robot.interfaces import AinexPerceptionObservation, OpenPIActionChunk, TrackedEntity


class ObservationBuilderTests(unittest.TestCase):
    """Test building OpenPI observations from AiNex perception."""

    def test_default_perception_builds_valid_observation(self) -> None:
        perception = default_perception()
        obs = build_observation(perception)
        self.assertEqual(len(obs.state), AINEX_STATE_DIM)
        self.assertEqual(obs.prompt, "")
        self.assertEqual(obs.schema_version, AINEX_SCHEMA_VERSION)

    def test_observation_state_normalized(self) -> None:
        perception = AinexPerceptionObservation(
            timestamp=1.0,
            battery_mv=12000,
            imu_roll=0.0,
            imu_pitch=0.0,
            is_walking=True,
            walk_x=0.05,  # max
            walk_y=-0.05,  # min
            walk_yaw=0.0,
            walk_height=0.036,
            walk_speed=2,
            head_pan=0.0,
            head_tilt=0.0,
        )
        obs = build_observation(perception)
        # walk_x at max should be ~1.0
        self.assertAlmostEqual(obs.state[0], 1.0, places=3)
        # walk_y at min should be ~-1.0
        self.assertAlmostEqual(obs.state[1], -1.0, places=3)
        # is_walking True should be 1.0
        self.assertAlmostEqual(obs.state[9], 1.0)

    def test_observation_with_entities(self) -> None:
        perception = AinexPerceptionObservation(
            timestamp=1.0,
            battery_mv=12000,
            imu_roll=0.0,
            imu_pitch=0.0,
            is_walking=False,
            walk_x=0.0,
            walk_y=0.0,
            walk_yaw=0.0,
            walk_height=0.036,
            walk_speed=2,
            head_pan=0.0,
            head_tilt=0.0,
            tracked_entities=(
                TrackedEntity(entity_id="obj1", label="cup", confidence=0.9, x=0.5, y=0.1, z=1.0, last_seen=1.0),
            ),
            language_instruction="pick up the cup",
        )
        obs = build_observation(perception)
        self.assertEqual(obs.prompt, "pick up the cup")
        self.assertIn("entities", obs.metadata)
        self.assertEqual(len(obs.metadata["entities"]), 1)
        self.assertEqual(obs.metadata["entities"][0]["label"], "cup")

    def test_observation_partial_entity_slots_are_padded(self) -> None:
        perception = AinexPerceptionObservation(
            timestamp=1.0,
            battery_mv=12000,
            imu_roll=0.0,
            imu_pitch=0.0,
            is_walking=False,
            walk_x=0.0,
            walk_y=0.0,
            walk_yaw=0.0,
            walk_height=0.036,
            walk_speed=2,
            head_pan=0.0,
            head_tilt=0.0,
            entity_slots=(0.25, -0.25),
        )
        obs = build_observation(perception)
        entity_part = obs.state[11:]
        self.assertEqual(entity_part[0], 0.25)
        self.assertEqual(entity_part[1], -0.25)
        self.assertTrue(all(v == 0.0 for v in entity_part[2:]))

    def test_observation_to_dict(self) -> None:
        perception = default_perception()
        obs = build_observation(perception)
        d = observation_to_dict(obs)
        self.assertIn("state", d)
        self.assertIsInstance(d["state"], list)
        self.assertEqual(len(d["state"]), AINEX_STATE_DIM)
        self.assertIn("prompt", d)
        self.assertEqual(d["schema_version"], AINEX_SCHEMA_VERSION)


class ActionDecoderTests(unittest.TestCase):
    """Test decoding OpenPI actions into AiNex control."""

    def test_decode_named_fields(self) -> None:
        raw = {
            "walk_x": 0.02,
            "walk_y": -0.01,
            "walk_yaw": 5.0,
            "walk_height": 0.04,
            "walk_speed": 3,
            "head_pan": 0.5,
            "head_tilt": -0.3,
            "confidence": 0.95,
        }
        action = decode_action(raw)
        self.assertAlmostEqual(action.walk_x, 0.02)
        self.assertAlmostEqual(action.walk_y, -0.01)
        self.assertEqual(action.walk_speed, 3)
        self.assertAlmostEqual(action.confidence, 0.95)
        self.assertEqual(action.schema_version, AINEX_SCHEMA_VERSION)

    def test_decode_named_fields_clamped(self) -> None:
        raw = {"walk_x": 1.0, "walk_y": -1.0}
        action = decode_action(raw)
        self.assertAlmostEqual(action.walk_x, 0.05)
        self.assertAlmostEqual(action.walk_y, -0.05)

    def test_decode_action_vector(self) -> None:
        # All zeros in normalized space -> midpoints
        raw = {"action": [0.0] * AINEX_ACTION_DIM}
        action = decode_action(raw)
        self.assertAlmostEqual(action.walk_x, 0.0, places=3)
        self.assertAlmostEqual(action.walk_y, 0.0, places=3)
        self.assertAlmostEqual(action.walk_yaw, 0.0, places=1)

    def test_decode_action_vector_extremes(self) -> None:
        # All 1.0 -> max values
        raw = {"action": [1.0] * AINEX_ACTION_DIM}
        action = decode_action(raw)
        self.assertAlmostEqual(action.walk_x, 0.05, places=3)
        self.assertAlmostEqual(action.walk_y, 0.05, places=3)
        self.assertEqual(action.walk_speed, 4)

    def test_decode_action_vector_short_raises(self) -> None:
        with self.assertRaises(ValueError):
            decode_action({"action": [0.0, 0.0, 0.0]})

    def test_action_to_bridge_commands_basic(self) -> None:
        action = OpenPIActionChunk(walk_x=0.01, walk_y=0.0, walk_yaw=0.0, walk_speed=2, walk_height=0.036)
        commands = action_to_bridge_commands(action)
        self.assertEqual(len(commands), 1)  # Just walk.set, no head (zeros)
        self.assertEqual(commands[0]["command"], "walk.set")
        self.assertAlmostEqual(commands[0]["payload"]["x"], 0.01)

    def test_action_to_bridge_commands_with_head(self) -> None:
        action = OpenPIActionChunk(
            walk_x=0.01, walk_y=0.0, walk_yaw=0.0,
            walk_speed=2, walk_height=0.036,
            head_pan=0.5, head_tilt=-0.3,
        )
        commands = action_to_bridge_commands(action)
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[1]["command"], "head.set")

    def test_action_to_bridge_commands_with_action_name(self) -> None:
        action = OpenPIActionChunk(
            walk_x=0.0, walk_y=0.0, walk_yaw=0.0,
            walk_speed=2, walk_height=0.036,
            action_name="wave",
        )
        commands = action_to_bridge_commands(action)
        self.assertTrue(any(c["command"] == "action.play" for c in commands))


if __name__ == "__main__":
    unittest.main()
