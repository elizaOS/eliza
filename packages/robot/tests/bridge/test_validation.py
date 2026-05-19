"""Payload validation tests."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.protocol import CommandEnvelope
from eliza_robot.bridge.validation import validate_command_payload


class ValidationTests(unittest.TestCase):
    def test_walk_set_valid(self) -> None:
        command = CommandEnvelope(
            request_id="1",
            timestamp="2026-02-28T00:00:00Z",
            command="walk.set",
            payload={"speed": 2, "height": 0.036, "x": 0.01, "y": 0.0, "yaw": 0.0},
        )
        validate_command_payload(command)

    def test_walk_set_invalid_speed(self) -> None:
        command = CommandEnvelope(
            request_id="2",
            timestamp="2026-02-28T00:00:00Z",
            command="walk.set",
            payload={"speed": 9, "height": 0.036, "x": 0.01, "y": 0.0, "yaw": 0.0},
        )
        with self.assertRaises(ValueError):
            validate_command_payload(command)

    def test_head_set_invalid_duration(self) -> None:
        command = CommandEnvelope(
            request_id="3",
            timestamp="2026-02-28T00:00:00Z",
            command="head.set",
            payload={"pan": 0.0, "tilt": 0.0, "duration": 0.0},
        )
        with self.assertRaises(ValueError):
            validate_command_payload(command)


if __name__ == "__main__":
    unittest.main()

