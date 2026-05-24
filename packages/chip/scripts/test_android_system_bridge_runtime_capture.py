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
            if command[:2] == ["sh", "-lc"] and "command -v" in command[2]:
                tool = command[2].split()[-1]
                if tool in {"adb", "cvd", "emulator"}:
                    return capture.Probe(True, f"/usr/bin/{tool}\n")
                return capture.Probe(False, "")
            if command[:2] == ["sh", "-lc"] and "ps -eo" in command[2]:
                return capture.Probe(True, " 123 1 00:01:00 adb -L tcp:5037 fork-server server\n")
            if command[:2] == ["sh", "-lc"] and "ss -ltnp" in command[2]:
                self.assertIn(":6520", command[2])
                return capture.Probe(
                    True,
                    "LISTEN 0 128 127.0.0.1:5037 0.0.0.0:* users:((\"adb\"))\n"
                    "LISTEN 0 128 0.0.0.0:6520 0.0.0.0:* users:((\"socket_vsock_proxy\"))\n",
                )
            if command[:2] == ["sh", "-lc"] and "latest_instance=" in command[2]:
                return capture.Probe(
                    True,
                    "latest_instance=/var/tmp/cvd/1000/1/home/cuttlefish/instances/cvd-1\n"
                    "log_file=/var/tmp/cvd/1000/1/home/cuttlefish/instances/cvd-1/logs/logcat bytes=0\n"
                    "android.security.maintenance could not be found\n",
                )
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
            with (
                mock.patch.object(capture, "run", side_effect=fake_run),
                mock.patch.object(capture, "AOSP_PRODUCT_OUT", tmp / "aosp/product"),
            ):
                report = capture.build_report(args)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["result"], 2)
        observations = report["observations"]
        self.assertIn("0.0.0.0:6520 offline", observations["adb_devices"])
        self.assertEqual(observations["adb_get_state"], "offline")
        self.assertFalse(observations["adb_get_state_available"])
        host_runtime = observations["host_runtime"]
        self.assertEqual(host_runtime["adb_ready_target_count"], 0)
        self.assertEqual(host_runtime["adb_blocker"], "no_ready_adb_device")
        self.assertEqual(
            host_runtime["adb_targets"],
            [{"serial": "0.0.0.0:6520", "state": "offline", "details": ""}],
        )
        self.assertTrue(host_runtime["tools"]["adb"]["available"])
        self.assertFalse(host_runtime["tools"]["launch_cvd"]["available"])
        self.assertIn(":6520", host_runtime["tcp_listeners"])
        self.assertIn("android.security.maintenance", host_runtime["cuttlefish_runtime"])
        artifact_inventory = host_runtime["aosp_build_only"]["artifact_inventory"]
        self.assertEqual(artifact_inventory["blocker_dependency"], "repo_artifact_generation")
        self.assertEqual(artifact_inventory["missing"], list(capture.AOSP_EXPECTED_ARTIFACT_NAMES))
        targets = observations["permission_file_symlink_targets"]
        self.assertEqual(set(targets), set(capture.PERMISSION_FILE_PATHS))
        self.assertIn("readlink_f", targets[capture.PERMISSION_FILE_PATHS[0]])
        self.assertIn(["adb", "devices", "-l"], commands)
        self.assertIn(["adb", "get-state"], commands)

    def test_adb_connect_attempt_is_recorded_and_selected(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command: list[str], timeout_seconds: int) -> capture.Probe:
            del timeout_seconds
            calls.append(command)
            if command == ["adb", "devices", "-l"] and len(calls) == 1:
                return capture.Probe(True, "List of devices attached\n")
            if command == ["adb", "connect", "127.0.0.1:6520"]:
                return capture.Probe(True, "connected to 127.0.0.1:6520\n")
            if command == ["adb", "devices", "-l"]:
                return capture.Probe(True, "List of devices attached\n127.0.0.1:6520 device\n")
            if command == ["adb", "-s", "127.0.0.1:6520", "get-state"]:
                return capture.Probe(True, "device\n")
            if command == [
                "adb",
                "-s",
                "127.0.0.1:6520",
                "shell",
                "ls",
                "-l",
                capture.DEFAULT_BRIDGE_SYSTEM_APK,
            ]:
                return capture.Probe(False, "No such file or directory\n")
            if command[:5] == ["adb", "-s", "127.0.0.1:6520", "shell", "sh"] and "pm list packages -f | grep -i eliza" in " ".join(command):
                return capture.Probe(True, "")
            if command[:2] == ["sh", "-lc"] and "command -v" in command[2]:
                return capture.Probe(True, "/usr/bin/tool\n")
            if command[:2] == ["sh", "-lc"]:
                return capture.Probe(True, "")
            return capture.Probe(False, "not booted\n")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            args = capture.parse_args(
                [
                    "--adb-connect",
                    "127.0.0.1:6520",
                    "--output",
                    str(tmp / "system_bridge_runtime_evidence.json"),
                    "--logcat",
                    str(tmp / "system_bridge_runtime_logcat.log"),
                ]
            )
            with mock.patch.object(capture, "run", side_effect=fake_run):
                report = capture.build_report(args)

        self.assertEqual(report["adb_serial"], "127.0.0.1:6520")
        attempts = report["observations"]["adb_connect_attempts"]
        self.assertTrue(
            any(item["command"] == ["adb", "connect", "127.0.0.1:6520"] for item in attempts),
            attempts,
        )
        self.assertIn(["adb", "-s", "127.0.0.1:6520", "get-state"], calls)

    def test_host_local_permission_symlink_blocks_pass(self) -> None:
        self.assertTrue(
            capture.contains_host_local_symlink(
                {
                    "/system/etc/permissions/foo.xml": (
                        "lrwxrwxrwx root root foo.xml -> "
                        "/home/ubuntu/eliza-aosp/packages/os/android/vendor/milady/permissions/foo.xml"
                    )
                }
            )
        )
        self.assertFalse(
            capture.contains_host_local_symlink(
                {"/system/etc/permissions/foo.xml": "foo.xml -> /vendor/etc/permissions/foo.xml"}
            )
        )


if __name__ == "__main__":
    unittest.main()
