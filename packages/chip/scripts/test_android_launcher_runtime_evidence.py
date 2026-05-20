#!/usr/bin/env python3
"""Tests for scripts/check_android_launcher_runtime_evidence.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_launcher_runtime_evidence as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2) + "\n")


def passing_payload(package: str = "ai.elizaos.app") -> dict:
    return {
        "schema": gate.SCHEMA,
        "claim_boundary": gate.CLAIM_BOUNDARY,
        "device": {
            "sys_boot_completed": "1",
            "cpu_abi": "riscv64",
            "lunch_target": "eliza_openagent_ai_soc_phone-trunk_staging-userdebug",
        },
        "app": {
            "package_name": package,
            "pm_path": "package:/system/priv-app/Eliza/Eliza.apk",
            "role_holders": {
                "android.app.role.ASSISTANT": [package],
                "android.app.role.BROWSER": [package],
            },
            "home_resolve_activity": f"{package}/.MainActivity",
            "foreground_activity": f"mResumedActivity: ActivityRecord{{ {package}/.MainActivity }}",
            "service_component": f"{package}/.ElizaAgentService",
            "service_pid": 31337,
        },
        "agent": {
            "health_url": "http://127.0.0.1:31337/api/health",
            "health_http": 200,
            "health_ready": True,
        },
        "logs": {
            "logcat_path": "docs/evidence/android/eliza_launcher_runtime_logcat.txt",
            "fatal_crash_count": 0,
            "avc_denial_count": 0,
        },
        "artifacts": {
            "transcript_path": "docs/evidence/android/eliza_launcher_runtime_transcript.log",
        },
    }


class AndroidLauncherRuntimeEvidenceTests(unittest.TestCase):
    def test_missing_evidence_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "DEFAULT_EVIDENCE", tmp / "missing.json"),
            ):
                report = gate.run_check(Namespace(evidence=None))
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["findings"][0]["code"], "missing_launcher_runtime_evidence")

    def test_incomplete_evidence_reports_runtime_blockers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            evidence = write_json(
                tmp / "evidence.json",
                {
                    "schema": gate.SCHEMA,
                    "claim_boundary": gate.CLAIM_BOUNDARY,
                    "device": {"sys_boot_completed": "0", "cpu_abi": "x86_64"},
                    "app": {
                        "package_name": "ai.elizaos.app",
                        "pm_path": "",
                        "role_holders": {},
                        "home_resolve_activity": "com.android.launcher/.Launcher",
                        "foreground_activity": "com.android.launcher/.Launcher",
                        "service_component": "ai.elizaos.app/.ElizaAgentService",
                        "service_pid": 0,
                    },
                    "agent": {
                        "health_url": "http://127.0.0.1:31337/api/status",
                        "health_http": 503,
                        "health_ready": False,
                    },
                    "logs": {
                        "logcat_path": "docs/evidence/android/missing-logcat.txt",
                        "fatal_crash_count": 1,
                        "avc_denial_count": 2,
                    },
                    "artifacts": {
                        "transcript_path": "docs/evidence/android/missing-transcript.log",
                    },
                },
            )
            with mock.patch.object(gate, "ROOT", tmp):
                report = gate.run_check(Namespace(evidence=str(evidence)))
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_boot_not_completed", codes)
        self.assertIn("android_device_not_riscv64", codes)
        self.assertIn("launcher_package_not_installed", codes)
        self.assertIn("home_resolve_not_eliza", codes)
        self.assertIn("foreground_activity_not_eliza", codes)
        self.assertIn("role_holders_do_not_include_eliza", codes)
        self.assertIn("agent_service_not_running", codes)
        self.assertIn("agent_health_url_not_app_contract", codes)
        self.assertIn("agent_health_http_not_200", codes)
        self.assertIn("agent_health_not_ready", codes)
        self.assertIn("fatal_crashes_present", codes)
        self.assertIn("selinux_denials_present", codes)
        self.assertIn("logcat_artifact_missing", codes)
        self.assertIn("launcher_transcript_artifact_missing", codes)

    def test_complete_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            evidence = write_json(tmp / "evidence.json", passing_payload())
            with mock.patch.object(gate, "ROOT", tmp):
                report = gate.run_check(Namespace(evidence=str(evidence)))
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)


if __name__ == "__main__":
    unittest.main()
