"""Tests for unified launch configuration."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.launch import resolve_target


class LaunchConfigTests(unittest.TestCase):
    def test_resolve_mock(self) -> None:
        target = resolve_target("mock")
        self.assertEqual(target.name, "mock")
        self.assertEqual(target.backend, "mock")
        self.assertFalse(target.requires_ros)

    def test_resolve_isaac(self) -> None:
        target = resolve_target("isaac")
        self.assertEqual(target.name, "isaac")
        self.assertEqual(target.backend, "isaac")
        self.assertFalse(target.requires_ros)

    def test_resolve_real(self) -> None:
        target = resolve_target("real")
        self.assertEqual(target.name, "real")
        self.assertEqual(target.backend, "ros_real")
        self.assertTrue(target.requires_ros)

    def test_resolve_sim(self) -> None:
        target = resolve_target("sim")
        self.assertEqual(target.name, "sim")
        self.assertEqual(target.backend, "ros_sim")
        self.assertTrue(target.requires_ros)

    def test_resolve_unknown(self) -> None:
        with self.assertRaises(ValueError):
            resolve_target("nonexistent")

    def test_target_has_ports(self) -> None:
        for name in ("real", "sim", "isaac", "mock", "asimov", "asimov-mujoco", "asimov-real"):
            target = resolve_target(name)
            self.assertGreater(target.rosbridge_port, 0)
            self.assertGreater(target.envelope_port, 0)
            self.assertGreater(target.publish_hz, 0)
            self.assertGreater(target.max_commands_per_sec, 0)
            self.assertGreater(target.deadman_timeout_sec, 0)

    def test_resolve_asimov_real_uses_livekit_env(self) -> None:
        import os
        from unittest import mock

        with mock.patch.dict(
            os.environ,
            {
                "ASIMOV_LIVEKIT_URL": "wss://asimov.example.invalid",
                "ASIMOV_LIVEKIT_TOKEN": "token-123",
            },
        ):
            target = resolve_target("asimov-real")

        self.assertEqual(target.name, "asimov-real")
        self.assertEqual(target.backend, "asimov_remote")
        self.assertEqual(target.profile_id, "asimov-1")
        self.assertEqual(target.envelope_port, 9104)
        self.assertEqual(target.asimov_livekit_url, "wss://asimov.example.invalid")
        self.assertEqual(target.asimov_livekit_token, "token-123")


if __name__ == "__main__":
    unittest.main()
