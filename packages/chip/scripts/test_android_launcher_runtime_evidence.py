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


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path: Path, payload: dict) -> Path:
    return write(path, json.dumps(payload, indent=2) + "\n")


def passing_payload(package: str = "ai.elizaos.app") -> dict:
    return {
        "schema": gate.SCHEMA,
        "status": "PASS",
        "result": 0,
        "claim_boundary": gate.CLAIM_BOUNDARY,
        "target_label": "chip-riscv64",
        "device": {
            "sys_boot_completed": "1",
            "cpu_abi": "riscv64",
            "lunch_target": "eliza_openagent_ai_soc_phone-trunk_staging-userdebug",
        },
        "app": {
            "package_name": package,
            "system_apk_path": "/system/priv-app/Eliza/Eliza.apk",
            "system_apk_present": "present",
            "system_apk_probe": "/system/priv-app/Eliza/Eliza.apk",
            "permission_file_probes": {
                "/system/etc/default-permissions/default-permissions-ai.elizaos.app.xml": "-rw-r--r-- root root default-permissions-ai.elizaos.app.xml",
                "/system/etc/permissions/privapp-permissions-ai.elizaos.app.xml": "-rw-r--r-- root root privapp-permissions-ai.elizaos.app.xml",
            },
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
        assert_false_claim_flags(self, report)
        self.assertEqual(report["findings"][0]["code"], "missing_launcher_runtime_evidence")
        self.assertEqual(report["blocker_dependency_counts"], {"live_device_validation": 1})
        self.assertEqual(
            report["summary"]["blocker_dependency_counts"],
            report["blocker_dependency_counts"],
        )
        self.assertEqual(report["summary"]["next_command_batch_count"], 1)
        self.assertEqual(
            report["next_command_plan"][0]["id"],
            "capture_android_launcher_runtime_evidence",
        )
        self.assertIn(
            "capture_launcher_runtime_evidence.py",
            " ".join(report["next_command_plan"][0]["commands"]),
        )
        capture_command = report["next_command_plan"][0]["commands"][1]
        self.assertIn("--adb-connect 127.0.0.1:6520", capture_command)
        self.assertIn("--adb-connect 127.0.0.1:5555", capture_command)
        self.assertIn(
            "--output packages/chip/docs/evidence/android/eliza_launcher_runtime_evidence.json",
            capture_command,
        )
        self.assertIn(
            "--logcat packages/chip/docs/evidence/android/eliza_launcher_runtime_logcat.txt",
            capture_command,
        )
        self.assertIn(
            "--transcript packages/chip/docs/evidence/android/eliza_launcher_runtime_transcript.log",
            capture_command,
        )

    def test_incomplete_evidence_reports_runtime_blockers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            evidence = write_json(
                tmp / "evidence.json",
                {
                    "schema": gate.SCHEMA,
                    "status": "FAIL",
                    "result": 1,
                    "claim_boundary": gate.CLAIM_BOUNDARY,
                    "device": {"sys_boot_completed": "0", "cpu_abi": "x86_64"},
                    "app": {
                        "package_name": "ai.elizaos.app",
                        "system_apk_path": "/system/priv-app/Eliza/Eliza.apk",
                        "system_apk_present": "missing",
                        "system_apk_probe": "ls: /system/priv-app/Eliza/Eliza.apk: No such file or directory",
                        "permission_file_probes": {
                            "/system/etc/default-permissions/default-permissions-ai.elizaos.app.xml": "lrw-r--r-- /system/etc/default-permissions/default-permissions-ai.elizaos.app.xml -> /home/ubuntu/eliza-aosp/src/packages/os/android/vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml"
                        },
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
        self.assertIn("launcher_evidence_status_not_pass", codes)
        self.assertIn("launcher_evidence_result_nonzero", codes)
        self.assertIn("android_device_cpu_abi_mismatch", codes)
        self.assertIn("launcher_package_not_installed", codes)
        self.assertIn("launcher_system_privapp_apk_missing", codes)
        self.assertIn("launcher_permission_xml_host_symlink", codes)
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
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", tmp / "missing.json"),
            ):
                report = gate.run_check(Namespace(evidence=str(evidence)))
        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["next_command_plan"], [])
        self.assertEqual(report["blocker_dependency_counts"], {})
        self.assertEqual(report["summary"]["next_command_batch_count"], 0)
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
        self.assertRegex(report["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")

    def test_expected_artifact_id_mismatch_blocks_cross_target_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload = passing_payload()
            payload["artifact_id"] = "android-chip-riscv64-zip"
            evidence = write_json(tmp / "evidence.json", payload)
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", tmp / "missing.json"),
            ):
                report = gate.run_check(
                    Namespace(
                        evidence=str(evidence),
                        expected_cpu_abi="riscv64",
                        expected_artifact_id="android-pixel-arm64-zip",
                    )
                )

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("launcher_evidence_artifact_id_mismatch", codes)
        self.assertEqual(report["evidence"]["artifact_id"], "android-chip-riscv64-zip")
        self.assertEqual(
            report["evidence"]["expected_artifact_id"],
            "android-pixel-arm64-zip",
        )

    def test_expected_target_label_mismatch_blocks_cross_target_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload = passing_payload()
            payload["artifact_id"] = "android-chip-riscv64-zip"
            payload["target_label"] = "chip-riscv64"
            evidence = write_json(tmp / "evidence.json", payload)
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", tmp / "missing.json"),
            ):
                report = gate.run_check(
                    Namespace(
                        evidence=str(evidence),
                        expected_cpu_abi="riscv64",
                        expected_artifact_id="android-chip-riscv64-zip",
                        expected_target_label="cuttlefish-riscv64",
                    )
                )

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("launcher_evidence_target_label_mismatch", codes)
        self.assertEqual(report["evidence"]["target_label"], "chip-riscv64")
        self.assertEqual(
            report["evidence"]["expected_target_label"],
            "cuttlefish-riscv64",
        )

    def test_permission_xml_symlink_detection_blocks_non_android_targets(self) -> None:
        self.assertTrue(
            gate.contains_host_local_symlink(
                {
                    "/system/etc/permissions/foo.xml": (
                        "lrwxrwxrwx root root foo.xml -> "
                        "/Users/build/src/packages/os/android/vendor/eliza/permissions/foo.xml"
                    )
                }
            )
        )
        self.assertFalse(
            gate.contains_host_local_symlink(
                {"/system/etc/permissions/foo.xml": "foo.xml -> /system/etc/permissions/foo.xml"}
            )
        )

    def test_stale_nonpass_top_level_status_blocks_even_if_fields_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload = passing_payload()
            payload["status"] = "BLOCKED"
            payload["result"] = 2
            evidence = write_json(tmp / "evidence.json", payload)
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", tmp / "missing.json"),
            ):
                report = gate.run_check(Namespace(evidence=str(evidence)))

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertEqual(
            codes,
            {
                "launcher_evidence_status_not_pass",
                "launcher_evidence_result_nonzero",
            },
        )

    def test_missing_system_apk_presence_state_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload = passing_payload()
            payload["app"].pop("system_apk_present")
            evidence = write_json(tmp / "evidence.json", payload)
            with mock.patch.object(gate, "ROOT", tmp):
                report = gate.run_check(Namespace(evidence=str(evidence)))

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("launcher_system_privapp_apk_missing", codes)

    def test_host_local_absolute_artifact_paths_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            payload = passing_payload()
            payload["logs"]["logcat_path"] = "/home/shaw/eliza_launcher_runtime_logcat.txt"
            payload["artifacts"]["transcript_path"] = "/tmp/eliza_launcher_runtime_transcript.log"
            evidence = write_json(tmp / "evidence.json", payload)
            with mock.patch.object(gate, "ROOT", tmp):
                report = gate.run_check(Namespace(evidence=str(evidence)))

        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("logcat_artifact_host_local_absolute_path", codes)
        self.assertIn("launcher_transcript_host_local_absolute_path", codes)

    def test_launcher_package_must_match_staged_apk_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload_report = write_json(
                tmp / "build/reports/android_system_apk_payload.json",
                {
                    "schema": "eliza.android_system_apk_payload.v1",
                    "status": "pass",
                    "evidence": {
                        "provenance_android_package": "ai.milady.milady",
                        "vendor_ro_elizaos_home": "ai.milady.milady",
                    },
                },
            )
            evidence = write_json(tmp / "evidence.json", passing_payload("ai.elizaos.app"))
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", payload_report),
            ):
                report = gate.run_check(Namespace(evidence=str(evidence)))

        self.assertEqual(report["status"], "blocked")
        self.assertIn(
            "launcher_package_mismatch_with_staged_apk",
            {finding["code"] for finding in report["findings"]},
        )
        self.assertEqual(report["evidence"]["expected_package"], "ai.milady.milady")

    def test_report_sanitizes_host_local_aosp_inventory_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_logcat.txt", "clean\n")
            write(tmp / "docs/evidence/android/eliza_launcher_runtime_transcript.log", "clean\n")
            payload = passing_payload()
            payload["observations"] = {
                "host_runtime": {
                    "aosp_build_only": {
                        "artifact_inventory": {
                            "product_out": "/home/shaw/aosp/out/target/product/eliza_ai_soc",
                            "records": [
                                {
                                    "name": "vendor.img",
                                    "path": "/home/shaw/aosp/out/target/product/eliza_ai_soc/vendor.img",
                                }
                            ],
                        }
                    }
                }
            }
            evidence = write_json(tmp / "evidence.json", payload)
            with (
                mock.patch.object(gate, "ROOT", tmp),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", tmp / "missing.json"),
            ):
                report = gate.run_check(Namespace(evidence=str(evidence)))

        inventory = report["evidence"]["aosp_build_artifact_inventory"]
        self.assertEqual(inventory["product_out"], "eliza_ai_soc")
        self.assertEqual(inventory["records"][0]["path"], "vendor.img")


if __name__ == "__main__":
    unittest.main()
