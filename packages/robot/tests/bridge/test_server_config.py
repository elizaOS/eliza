"""Tests for direct bridge server runtime configuration."""

from __future__ import annotations

import argparse
import os
import unittest
from unittest import mock

from eliza_robot.bridge.server import _coerce_runtime_config


def _args(**overrides: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "queue_size": 256,
        "max_commands_per_sec": 30,
        "deadman_timeout_sec": 1.0,
        "trace_log_path": "",
        "profile": "asimov-1",
        "mujoco_target_x": 2.0,
        "mujoco_target_y": 0.0,
        "mujoco_target_z": 0.05,
        "camera_device": -1,
        "camera_width": 640,
        "camera_height": 480,
        "rosbridge_host": "192.168.1.218",
        "rosbridge_port": 9090,
        "asimov_livekit_url": "",
        "asimov_livekit_token": "",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class ServerConfigTests(unittest.TestCase):
    def test_asimov_livekit_env_fills_direct_server_config(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "ASIMOV_LIVEKIT_URL": "wss://asimov.example.invalid",
                "ASIMOV_LIVEKIT_TOKEN": "token-123",
            },
        ):
            config = _coerce_runtime_config(_args(), {})

        self.assertEqual(config.asimov_livekit_url, "wss://asimov.example.invalid")
        self.assertEqual(config.asimov_livekit_token, "token-123")

    def test_asimov_livekit_cli_args_override_env(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "ASIMOV_LIVEKIT_URL": "wss://env.example.invalid",
                "ASIMOV_LIVEKIT_TOKEN": "env-token",
            },
        ):
            config = _coerce_runtime_config(
                _args(
                    asimov_livekit_url="wss://cli.example.invalid",
                    asimov_livekit_token="cli-token",
                ),
                {},
            )

        self.assertEqual(config.asimov_livekit_url, "wss://cli.example.invalid")
        self.assertEqual(config.asimov_livekit_token, "cli-token")


if __name__ == "__main__":
    unittest.main()
