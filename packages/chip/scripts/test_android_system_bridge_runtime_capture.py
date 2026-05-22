#!/usr/bin/env python3
"""Tests for scripts/android/capture_system_bridge_runtime_evidence.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts" / "android"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_system_bridge_runtime_evidence as capture  # noqa: E402


class SystemBridgeRuntimeCaptureTests(unittest.TestCase):
    def test_blocked_capture_records_adb_target_diagnostics(self) -> None:
        commands: list[list[str]] = []

        def fake_run(command: list[str], timeout_seconds: int) -> capture.Probe:
            del timeout_seconds
            commands.append(command)
            if command == ["adb", "devices", "-l"]:
                return capture.Probe(True, "List of devices attached\n0.0.0.0:6520 offline\n")
            if command == ["adb", "get-state"]:
                return capture.Probe(False, "offline\n")
            return capture.Probe(False, "adb: device offline\n")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            args = capture.parse_args(
                [
                    "--output",
                    str(tmp / "system_bridge_runtime_evidence.json"),
                    "--logcat",
                    str(tmp / "system_bridge_runtime_logcat.log"),
                ]
            )
            with mock.patch.object(capture, "run", side_effect=fake_run):
                report = capture.build_report(args)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["result"], 2)
        observations = report["observations"]
        self.assertIn("0.0.0.0:6520 offline", observations["adb_devices"])
        self.assertEqual(observations["adb_get_state"], "offline")
        self.assertFalse(observations["adb_get_state_available"])
        self.assertIn(["adb", "devices", "-l"], commands)
        self.assertIn(["adb", "get-state"], commands)


if __name__ == "__main__":
    unittest.main()
