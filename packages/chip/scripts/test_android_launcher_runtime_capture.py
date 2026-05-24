#!/usr/bin/env python3
"""Tests for scripts/android/capture_launcher_runtime_evidence.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts" / "android"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_launcher_runtime_evidence as capture  # noqa: E402


class LauncherRuntimeCaptureTests(unittest.TestCase):
    def test_blocked_capture_records_adb_target_diagnostics(self) -> None:
        commands: list[list[str]] = []

        def fake_run(command: list[str], timeout_seconds: int) -> capture.Probe:
            del timeout_seconds
            commands.append(command)
            if command == ["adb", "devices", "-l"]:
                return capture.Probe(
                    True,
                    "List of devices attached\n0.0.0.0:6520 offline product:cf_riscv64\n",
                )
            if command == ["adb", "get-state"]:
                return capture.Probe(False, "offline\n")
            if command[:2] == ["sh", "-lc"] and "ps -eo" in command[2]:
                return capture.Probe(True, " 123 1 00:01:00 adb -L tcp:5037 fork-server server\n")
            if command[:2] == ["sh", "-lc"] and "ss -ltnp" in command[2]:
                self.assertIn(":6520", command[2])
                return capture.Probe(
                    True,
                    'LISTEN 0 128 127.0.0.1:5037 0.0.0.0:* users:(("adb"))\n'
                    'LISTEN 0 128 0.0.0.0:6520 0.0.0.0:* users:(("socket_vsock_proxy"))\n',
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
                    str(tmp / "eliza_launcher_runtime_evidence.json"),
                    "--logcat",
                    str(tmp / "eliza_launcher_runtime_logcat.txt"),
                    "--transcript",
                    str(tmp / "eliza_launcher_runtime_transcript.log"),
                ]
            )
            with (
                mock.patch.object(capture, "run", side_effect=fake_run),
                mock.patch.object(capture, "AOSP_PRODUCT_OUT", tmp / "aosp/product"),
            ):
                report = capture.build_report(args)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["result"], 2)
        self.assertEqual(report["schema"], capture.SCHEMA)
        self.assertEqual(report["claim_boundary"], capture.CLAIM_BOUNDARY)
        self.assertEqual(report["target_label"], "chip-riscv64")
        observations = report["observations"]
        self.assertEqual(observations["adb_get_state"], "offline")
        self.assertFalse(observations["adb_get_state_available"])
        self.assertEqual(observations["host_runtime"]["adb_ready_target_count"], 0)
        self.assertEqual(observations["host_runtime"]["adb_blocker"], "no_ready_adb_device")
        self.assertIn(":6520", observations["host_runtime"]["tcp_listeners"])
        self.assertIn(
            "android.security.maintenance", observations["host_runtime"]["cuttlefish_runtime"]
        )
        artifact_inventory = observations["host_runtime"]["aosp_build_only"]["artifact_inventory"]
        self.assertEqual(artifact_inventory["blocker_dependency"], "repo_artifact_generation")
        self.assertEqual(artifact_inventory["missing"], list(capture.AOSP_EXPECTED_ARTIFACT_NAMES))
        self.assertIn("sys_boot_completed", observations["missing_or_false"])
        self.assertIn("agent_health_http_200", observations["missing_or_false"])
        targets = report["app"]["permission_file_symlink_targets"]
        self.assertEqual(set(targets), set(capture.PERMISSION_FILE_PATHS))
        self.assertIn("readlink_f", targets[capture.PERMISSION_FILE_PATHS[0]])
        self.assertIn(["adb", "devices", "-l"], commands)
        self.assertIn(["adb", "get-state"], commands)

    def test_passing_capture_shape_satisfies_launcher_gate(self) -> None:
        package = capture.DEFAULT_PACKAGE

        def fake_run(command: list[str], timeout_seconds: int) -> capture.Probe:
            del timeout_seconds
            text = " ".join(command)
            if command == ["adb", "devices", "-l"]:
                return capture.Probe(True, "List of devices attached\n0.0.0.0:6520 device\n")
            if command == ["adb", "get-state"]:
                return capture.Probe(True, "device\n")
            if command[:2] == ["sh", "-lc"]:
                return capture.Probe(True, "")
            if "getprop sys.boot_completed" in text:
                return capture.Probe(True, "1\n")
            if "getprop ro.product.cpu.abi" in text:
                return capture.Probe(True, "riscv64\n")
            if "getprop ro.product.cpu.abilist" in text:
                return capture.Probe(True, "riscv64\n")
            if "uname -m" in text:
                return capture.Probe(True, "riscv64\n")
            if "getprop ro.build.id" in text:
                return capture.Probe(True, "ELIZA\n")
            if "getprop ro.build.version.sdk" in text:
                return capture.Probe(True, "36\n")
            if f"ls -l {capture.DEFAULT_SYSTEM_APK}" in text:
                return capture.Probe(
                    True, f"-rw-r--r-- 1 root root 1 2026-05-22 {capture.DEFAULT_SYSTEM_APK}\n"
                )
            if "pm list packages -f | grep -i eliza" in text:
                return capture.Probe(True, f"package:{capture.DEFAULT_SYSTEM_APK}={package}\n")
            if f"pm path {package}" in text:
                return capture.Probe(True, f"package:{capture.DEFAULT_SYSTEM_APK}\n")
            if "resolve-activity" in text:
                return capture.Probe(True, f"{package}/.MainActivity\n")
            if "dumpsys activity activities" in text:
                return capture.Probe(
                    True, f"mResumedActivity: ActivityRecord{{ {package}/.MainActivity }}\n"
                )
            if "dumpsys window" in text:
                return capture.Probe(True, "")
            if "dumpsys activity services" in text:
                return capture.Probe(True, f"ServiceRecord{{ {package}/.ElizaAgentService }}\n")
            if f"pidof {package}" in text:
                return capture.Probe(True, "31337\n")
            if "forward tcp:31337 tcp:31337" in text:
                return capture.Probe(True, "")
            if "logcat -d -b all" in text:
                return capture.Probe(True, "I PackageManager Eliza clean launcher boot\n")
            if "cmd role holders" in text:
                return capture.Probe(True, f"{package}\n")
            return capture.Probe(True, "")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            args = capture.parse_args(
                [
                    "--output",
                    str(tmp / "docs/evidence/android/eliza_launcher_runtime_evidence.json"),
                    "--target-label",
                    "chip-riscv64",
                    "--logcat",
                    str(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt"),
                    "--transcript",
                    str(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log"),
                ]
            )
            with (
                mock.patch.object(capture, "run", side_effect=fake_run),
                mock.patch.object(
                    capture, "http_health", return_value=(200, True, '{"ready":true}')
                ),
            ):
                report = capture.build_report(args)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

            sys.path.insert(0, str(ROOT / "scripts"))
            import check_android_launcher_runtime_evidence as gate  # noqa: PLC0415

            with mock.patch.object(gate, "ROOT", tmp):
                gate_report = gate.run_check(type("Args", (), {"evidence": str(args.output)})())

        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["target_label"], "chip-riscv64")
        self.assertEqual(
            set(report["app"]["permission_file_symlink_targets"]),
            set(capture.PERMISSION_FILE_PATHS),
        )
        self.assertEqual(gate_report["status"], "pass")


if __name__ == "__main__":
    unittest.main()
