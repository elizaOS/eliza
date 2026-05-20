"""Protocol parsing tests."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.protocol import parse_command
from eliza_robot.bridge.types import JsonDict


class ParseCommandTests(unittest.TestCase):
    def test_parse_valid_command_with_preempt(self) -> None:
        payload: JsonDict = {
            "type": "command",
            "request_id": "abc",
            "timestamp": "2026-02-28T00:00:00Z",
            "command": "walk.command",
            "payload": {"action": "stop"},
            "preempt": True,
        }
        command = parse_command(payload)
        self.assertEqual(command.request_id, "abc")
        self.assertEqual(command.command, "walk.command")
        self.assertTrue(command.preempt)

    def test_parse_rejects_invalid_preempt_type(self) -> None:
        payload: JsonDict = {
            "type": "command",
            "request_id": "abc",
            "timestamp": "2026-02-28T00:00:00Z",
            "command": "walk.command",
            "payload": {"action": "stop"},
            "preempt": "yes",
        }
        with self.assertRaises(ValueError):
            parse_command(payload)


if __name__ == "__main__":
    unittest.main()

