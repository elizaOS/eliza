"""Tests for policy lifecycle protocol commands and validation."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.protocol import CommandEnvelope, parse_command
from eliza_robot.bridge.validation import validate_command_payload


class PolicyProtocolTests(unittest.TestCase):
    """Test parsing and validation of policy.* commands."""

    def test_parse_policy_start(self) -> None:
        payload = {
            "type": "command",
            "request_id": "p1",
            "timestamp": "2026-02-28T00:00:00Z",
            "command": "policy.start",
            "payload": {"task": "walk to the table"},
        }
        cmd = parse_command(payload)
        self.assertEqual(cmd.command, "policy.start")
        self.assertEqual(cmd.payload["task"], "walk to the table")

    def test_validate_policy_start_requires_task(self) -> None:
        cmd = CommandEnvelope(
            request_id="p2",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.start",
            payload={},
        )
        with self.assertRaises(ValueError):
            validate_command_payload(cmd)

    def test_validate_policy_start_hz_range(self) -> None:
        cmd = CommandEnvelope(
            request_id="p3",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.start",
            payload={"task": "test", "hz": 50.0},
        )
        with self.assertRaises(ValueError):
            validate_command_payload(cmd)

    def test_validate_policy_start_valid_with_hz(self) -> None:
        cmd = CommandEnvelope(
            request_id="p4",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.start",
            payload={"task": "test", "hz": 10.0, "max_steps": 5000},
        )
        validate_command_payload(cmd)  # Should not raise

    def test_validate_policy_stop(self) -> None:
        cmd = CommandEnvelope(
            request_id="p5",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.stop",
            payload={"reason": "test_done"},
        )
        validate_command_payload(cmd)  # Should not raise

    def test_validate_policy_tick(self) -> None:
        cmd = CommandEnvelope(
            request_id="p6",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.tick",
            payload={"action": {"walk_x": 0.01, "walk_y": 0.0}},
        )
        validate_command_payload(cmd)  # Should not raise

    def test_validate_policy_status(self) -> None:
        cmd = CommandEnvelope(
            request_id="p7",
            timestamp="2026-02-28T00:00:00Z",
            command="policy.status",
            payload={},
        )
        validate_command_payload(cmd)  # Should not raise


if __name__ == "__main__":
    unittest.main()
