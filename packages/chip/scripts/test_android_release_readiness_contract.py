#!/usr/bin/env python3
"""Tests for scripts/check_android_release_readiness_contract.py."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_release_readiness_contract as gate  # noqa: E402


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_android_archive(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for member in gate.ANDROID_ARCHIVE_REQUIRED_MEMBERS:
            archive.writestr(member, f"{member}\n")
    return path


CURRENT_ANDROID_MANIFEST = """{
  "schemaVersion": 1,
  "releaseId": "elizaos-android-beta-2026.05.16",
  "buildFingerprint": "elizaos/caiman/caiman:16/beta-2026.05.16:userdebug/test-keys",
  "supportedDevices": [{"codename": "caiman", "marketingName": "Pixel 9 Pro"}],
  "artifacts": [
    {"partition": "boot", "filename": "boot.img", "sha256": "0000000000000000000000000000000000000000000000000000000000000000", "sizeBytes": 1}
  ],
  "validation": {
    "properties": {
      "ro.product.device": "caiman",
      "sys.boot_completed": "1"
    }
  }
}
"""


CURRENT_UMBRELLA_MANIFEST = """{
  "schemaVersion": 1,
  "artifacts": [
    {
      "id": "android-cuttlefish-x86_64-zip",
      "kind": "android-image",
      "target": {"platform": "cuttlefish", "architecture": "x86_64", "device": "cf_x86_64_phone"},
      "sizeBytes": null,
      "sha256": null,
      "validation": {"requiredEvidence": ["assistant-role-validation"], "evidence": []}
    },
    {
      "id": "android-pixel-arm64-zip",
      "kind": "android-image",
      "target": {"platform": "android", "architecture": "arm64", "device": "pixel-supported"},
      "sizeBytes": null,
      "sha256": null,
      "validation": {"requiredEvidence": ["assistant-role-validation"], "evidence": []}
    }
  ]
}
"""


PASSING_ANDROID_MANIFEST = """{
  "schemaVersion": 1,
  "releaseId": "elizaos-android-beta-2026.05.16",
  "buildFingerprint": "elizaos/eliza_ai_soc_riscv64/eliza_ai_soc_riscv64:16/beta:userdebug/test-keys",
  "supportedDevices": [{"codename": "eliza-chip", "marketingName": "Eliza AI SoC"}],
  "artifacts": [
    {"partition": "boot", "filename": "boot.img", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sizeBytes": 4096}
  ],
  "validation": {
    "properties": {
      "ro.product.device": "eliza-chip",
      "sys.boot_completed": "1",
      "pm_path": "package:/system/priv-app/Eliza/Eliza.apk",
      "home_role": "ai.elizaos.app",
      "foreground_activity": "ai.elizaos.app/.MainActivity",
      "agent_service_pid": "present",
      "agent_health": "/api/health 200 ready",
      "logcat_fatal_count": "0",
      "selinux_avc_denied_count": "0"
    },
    "artifactIntegrity": {
      "status": "collected",
      "artifactDirectory": "os/release/beta-2026-05-16/android/partitions",
      "evidence": "evidence/android/android-partition-artifacts-integrity.json",
      "requiredFiles": ["boot.img"]
    }
  }
}
"""


PASSING_UMBRELLA_MANIFEST = """{
  "schemaVersion": 1,
  "artifacts": [
    {
      "id": "android-chip-riscv64-zip",
      "kind": "android-image",
      "target": {"platform": "eliza-chip", "architecture": "riscv64", "device": "eliza_ai_soc"},
      "filename": "elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
      "sizeBytes": 8192,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "validation": {
        "requiredEvidence": ["assistant-role-validation", "agent-health-smoke"],
        "evidence": [
          {
            "id": "android-chip-riscv64-artifact-integrity",
            "status": "collected",
            "path": "evidence/android/chip-riscv64-artifact-integrity.json"
          },
          {
            "id": "android-chip-riscv64-launcher-agent-live",
            "status": "collected",
            "path": "evidence/android/chip-riscv64-launcher-agent-live.json"
          }
        ]
      }
    }
  ]
}
"""

PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD = """{
  "schema": "eliza.android_release_launcher_agent_liveness.v1",
  "status": "collected",
  "artifact_id": "android-chip-riscv64-zip",
  "observed": {
    "sys_boot_completed": true,
    "package_installed": true,
    "home_resolved_to_launcher": true,
    "foreground_activity": true,
    "agent_service_running": true,
    "agent_health_ready": true,
    "logcat_no_fatal": true,
    "selinux_no_denials": true
  }
}
"""


PASSING_PARTITION_INTEGRITY_PAYLOAD = """{
  "schema": "eliza.android_release_partition_artifacts_integrity.v1",
  "status": "collected",
  "claim_boundary": "partition_artifact_integrity_only_not_boot_or_launcher_liveness",
  "artifacts": [
    {
      "partition": "boot",
      "filename": "boot.img",
      "sizeBytes": 4096,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
"""


FULL_VALIDATOR_SCRIPT = """#!/usr/bin/env bash
adb shell pm path ai.elizaos.app
adb shell cmd role holders android.app.role.HOME
adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME
adb shell dumpsys package ai.elizaos.app
adb shell dumpsys activity activities
adb shell pidof ai.elizaos.app
adb shell curl http://127.0.0.1:3000/api/health
adb logcat -d | grep -i fatal
adb logcat -d | grep -i 'avc: denied'
"""


class AndroidReleaseReadinessContractTests(unittest.TestCase):
    def _complete_aosp_chip_inventory(self) -> dict[str, object]:
        return {
            "status": "complete",
            "productOut": "/tmp/aosp/out/target/product/eliza_ai_soc",
            "present": ["vendor.img", "system.img", "product.img", "system_ext.img"],
            "missing": [],
            "records": [],
            "blocker_dependency": "",
            "next_step": "stage",
        }

    def _partial_aosp_chip_inventory(self) -> dict[str, object]:
        return {
            "status": "partial",
            "productOut": "/tmp/aosp/out/target/product/eliza_ai_soc",
            "present": ["vendor.img", "system.img"],
            "missing": ["product.img", "system_ext.img"],
            "records": [],
            "blocker_dependency": "repo_artifact_generation",
            "next_step": "finish build",
        }

    def _patch_tree(self, tmp: Path):
        android_manifest = write(
            tmp / "os/release/beta-2026-05-16/android-release-manifest.json",
            CURRENT_ANDROID_MANIFEST,
        )
        umbrella_manifest = write(
            tmp / "os/release/beta-2026-05-16/manifest.json",
            CURRENT_UMBRELLA_MANIFEST,
        )
        post_flash = write(
            tmp / "os/android/installer/scripts/validate-post-flash.sh",
            "adb shell getprop ro.product.device\nadb shell getprop sys.boot_completed\n",
        )
        installer = write(
            tmp / "os/android/installer/install-elizaos-android.sh",
            "adb shell getprop ro.build.fingerprint\nadb shell getprop sys.boot_completed\n",
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", tmp),
            mock.patch.object(gate, "REPO_ROOT", tmp),
            mock.patch.object(gate, "RELEASE_DIR", tmp / "os/release/beta-2026-05-16"),
            mock.patch.object(
                gate,
                "RELEASE_ANDROID_PARTITIONS_DIR",
                tmp / "os/release/beta-2026-05-16/android/partitions",
            ),
            mock.patch.object(
                gate,
                "RELEASE_ANDROID_ARCHIVES_DIR",
                tmp / "os/release/beta-2026-05-16/android/archives",
            ),
            mock.patch.object(gate, "ANDROID_MANIFEST", android_manifest),
            mock.patch.object(gate, "UMBRELLA_MANIFEST", umbrella_manifest),
            mock.patch.object(gate, "POST_FLASH", post_flash),
            mock.patch.object(gate, "INSTALLER", installer),
            mock.patch.object(
                gate,
                "LAUNCHER_RUNTIME_REPORT",
                tmp / "chip/build/reports/android_launcher_runtime_evidence.json",
            ),
            mock.patch.object(
                gate,
                "SYSTEM_BRIDGE_REPORT",
                tmp / "chip/build/reports/android_system_bridge_contract.json",
            ),
            mock.patch.object(
                gate,
                "ANDROID_APK_PAYLOAD_REPORT",
                tmp / "chip/build/reports/android_system_apk_payload.json",
            ),
        ]
        return patches

    def _passing_launcher_runtime_payload(self) -> dict[str, object]:
        return {
            "schema": gate.LAUNCHER_RUNTIME_SCHEMA,
            "status": "PASS",
            "result": 0,
            "claim_boundary": gate.LAUNCHER_RUNTIME_CLAIM_BOUNDARY,
            "target_label": "chip-riscv64",
            "device": {"sys_boot_completed": "1"},
            "app": {
                "package_name": "ai.elizaos.app",
                "system_apk_present": "present",
                "pm_path": "package:/system/priv-app/Eliza/Eliza.apk",
                "home_resolve_activity": "ai.elizaos.app/.MainActivity",
                "foreground_activity": "ai.elizaos.app/.MainActivity",
                "service_pid": 31337,
            },
            "agent": {"health_http": 200, "health_ready": True},
            "logs": {
                "fatal_crash_count": 0,
                "avc_denial_count": 0,
            },
        }

    def test_launcher_runtime_payload_uses_capture_log_counter_keys(self) -> None:
        payload = self._passing_launcher_runtime_payload()

        self.assertEqual(
            gate._launcher_runtime_payload_gaps(
                payload,
                expected_target_label="chip-riscv64",
            ),
            [],
        )

    def test_launcher_runtime_payload_blocks_conflicting_legacy_log_counts(self) -> None:
        payload = self._passing_launcher_runtime_payload()
        payload["logs"] = {
            "fatal_crash_count": 0,
            "fatal_count": 1,
            "avc_denial_count": 0,
            "selinux_avc_denied_count": 2,
        }

        gaps = gate._launcher_runtime_payload_gaps(
            payload,
            expected_target_label="chip-riscv64",
        )

        self.assertIn(
            "fatal_count=1 conflicts_with_fatal_crash_count=0",
            gaps,
        )
        self.assertIn(
            "selinux_avc_denied_count=2 conflicts_with_avc_denial_count=0",
            gaps,
        )

    def test_placeholder_release_manifests_and_thin_validators_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        self.assertEqual(report["summary"]["blockers"], len(report["blockers"]))
        self.assertGreater(report["blocker_dependency_counts"]["repo_artifact_generation"], 0)
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_release_manifest_uses_placeholder_hashes", codes)
        self.assertIn("android_release_manifest_uses_sentinel_sizes", codes)
        self.assertIn("android_release_manifest_missing_chip_riscv64_target", codes)
        self.assertIn("android_release_validation_missing_launcher_agent_checks", codes)
        self.assertIn("post_flash_validator_missing_launcher_agent_checks", codes)
        self.assertIn("installer_reboot_validation_missing_launcher_agent_checks", codes)
        self.assertIn("umbrella_android_artifacts_missing_integrity", codes)
        self.assertIn("android_release_artifacts_missing_from_expected_paths", codes)
        self.assertIn("umbrella_android_artifacts_missing_evidence", codes)
        self.assertIn("umbrella_android_artifacts_missing_required_evidence_rows", codes)
        self.assertIn("android_live_launcher_agent_evidence_missing_by_target", codes)
        self.assertIn("umbrella_missing_android_riscv64_chip_artifact", codes)
        findings_by_code = {finding["code"]: finding for finding in report["findings"]}
        self.assertIn(
            "build-aosp",
            findings_by_code["android_release_artifacts_missing_from_expected_paths"][
                "next_command"
            ],
        )
        self.assertTrue(
            any(
                "check_android_release_readiness_contract.py" in command
                for command in findings_by_code[
                    "android_release_artifacts_missing_from_expected_paths"
                ]["next_commands"]
            )
        )
        self.assertIn(
            "capture_launcher_runtime_evidence.py",
            findings_by_code["android_live_launcher_agent_evidence_missing_by_target"][
                "next_command"
            ],
        )
        self.assertTrue(
            any(
                "check_android_launcher_runtime_evidence.py" in command
                for command in findings_by_code[
                    "android_live_launcher_agent_evidence_missing_by_target"
                ]["next_commands"]
            )
        )
        self.assertEqual(
            report["summary"]["blocker_dependency_counts"],
            report["blocker_dependency_counts"],
        )
        inventory = report["evidence"]["android_release_artifact_inventory"]
        self.assertEqual(inventory["status"], "blocked")
        self.assertIn(
            "os/release/beta-2026-05-16/android/partitions/boot.img",
            inventory["missing"]["partitionArtifacts"],
        )
        staged_inventory = report["evidence"]["staged_android_archive_integrity_inventory"]
        self.assertEqual(staged_inventory["status"], "blocked")
        self.assertIn(
            "android-cuttlefish-x86_64-zip:filename=<missing>",
            staged_inventory["missingArchives"],
        )
        self.assertIn("buildPixelCaimanPartitions", inventory["commands"])
        live_commands = report["evidence"]["live_launcher_agent_capture_commands"]
        self.assertEqual(
            live_commands["claimBoundary"],
            "operator_commands_only_not_collected_runtime_evidence",
        )
        self.assertIn("pixelArm64", live_commands)
        self.assertTrue(
            any("validate-post-flash.sh" in command for command in live_commands["pixelArm64"])
        )
        self.assertTrue(
            any(
                "cuttlefish-x86_64-launcher-agent-live.json" in command
                for command in live_commands["cuttlefishX8664"]
            )
        )
        self.assertTrue(any("--adb-connect" in command for command in live_commands["chipRiscv64"]))
        self.assertTrue(
            any(
                "--expected-artifact-id android-chip-riscv64-zip" in command
                and "--expected-cpu-abi riscv64" in command
                and "--expected-target-label chip-riscv64" in command
                for command in live_commands["chipRiscv64"]
            )
        )
        missing_live = report["evidence"]["live_launcher_agent_missing_evidence"]
        self.assertEqual(missing_live["status"], "blocked")
        self.assertEqual(
            missing_live["missingTargets"],
            ["android-cuttlefish-x86_64-zip", "android-pixel-arm64-zip"],
        )
        live_by_id = {row["artifactId"]: row for row in missing_live["records"]}
        self.assertEqual(
            live_by_id["android-cuttlefish-x86_64-zip"]["expectedCpuAbi"],
            "x86_64",
        )
        self.assertEqual(
            live_by_id["android-cuttlefish-x86_64-zip"]["expectedTargetLabel"],
            "cuttlefish-x86_64",
        )
        self.assertFalse(live_by_id["android-cuttlefish-x86_64-zip"]["releaseCredit"])
        self.assertIn(
            "os/release/beta-2026-05-16/evidence/android/cuttlefish-x86_64-launcher-agent-live.json",
            live_by_id["android-cuttlefish-x86_64-zip"]["expectedOutputFiles"],
        )
        self.assertIn(
            "--expected-target-label cuttlefish-x86_64",
            live_by_id["android-cuttlefish-x86_64-zip"]["validationCommand"],
        )
        self.assertTrue(
            any(
                "--expected-cpu-abi arm64-v8a" in command
                and "--expected-artifact-id android-pixel-arm64-zip" in command
                and "--expected-target-label pixel-arm64" in command
                for command in live_by_id["android-pixel-arm64-zip"]["collectionCommands"]
            )
        )
        prioritized = report["evidence"]["prioritized_live_evidence_capture_plan"]
        self.assertEqual(
            [row["capture_area"] for row in prioritized],
            [
                "cuttlefish-x86_64",
                "pixel-arm64",
                "peripherals",
                "security_lifecycle",
                "power_thermal",
            ],
        )
        self.assertTrue(all(row["release_credit"] is False for row in prioritized))
        cuttlefish = prioritized[0]
        self.assertIn(
            "os/release/beta-2026-05-16/evidence/android/cuttlefish-x86_64-launcher-agent-live.json",
            cuttlefish["expected_output_files"],
        )
        self.assertTrue(
            any(
                "--expected-cpu-abi x86_64" in command for command in cuttlefish["capture_commands"]
            )
        )
        peripherals = {row["capture_area"]: row for row in prioritized}["peripherals"]
        self.assertTrue(
            any(
                path.endswith("cellular_5g_lte_sim.log")
                for path in peripherals["expected_output_files"]
            )
        )
        self.assertTrue(
            any(
                "capture_simulated_peripheral_evidence.py" in command
                for command in peripherals["capture_commands"]
            )
        )
        security = {row["capture_area"]: row for row in prioritized}["security_lifecycle"]
        self.assertTrue(
            any(
                path.endswith("rollback_rejection.log")
                for path in security["expected_output_files"]
            )
        )
        self.assertTrue(
            any(
                "ELIZA_ROLLBACK_REJECTION_COMMAND" in command
                for command in security["capture_commands"]
            )
        )
        self.assertTrue(
            any(
                "verdict=pass" in command and "RESULT=%s" in command
                for command in security["capture_commands"]
            )
        )
        power = {row["capture_area"]: row for row in prioritized}["power_thermal"]
        self.assertTrue(
            any(
                path.endswith("sustained_npu_power_thermal_trace.json")
                for path in power["expected_output_files"]
            )
        )
        self.assertTrue(
            any(
                "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND" in command
                for command in power["capture_commands"]
            )
        )
        command_plan = report["next_command_plan"]
        self.assertEqual(report["summary"]["next_command_batch_count"], len(command_plan))
        command_plan_by_id = {row["id"]: row for row in command_plan}
        self.assertIn("capture_android_release_artifact_integrity", command_plan_by_id)
        self.assertIn("capture_android_release_artifact_staging", command_plan_by_id)
        self.assertIn(
            "capture_android_release_cuttlefish-x86_64_live_evidence",
            command_plan_by_id,
        )
        self.assertIn(
            "capture_android_release_power_thermal_live_evidence",
            command_plan_by_id,
        )
        self.assertTrue(
            any(
                "sha256sum" in command or "generateArchiveIntegrityEvidence" in command
                for command in command_plan_by_id["capture_android_release_artifact_integrity"][
                    "commands"
                ]
            )
        )
        self.assertTrue(
            any(
                "capture_launcher_runtime_evidence.py" in command
                for command in command_plan_by_id[
                    "capture_android_release_cuttlefish-x86_64_live_evidence"
                ]["commands"]
            )
        )
        self.assertTrue(
            all(
                row["claim_boundary"]
                == "operator_commands_only_not_android_release_or_runtime_evidence"
                for row in command_plan
            )
        )

    def test_live_launcher_missing_evidence_inventory_is_target_specific(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            umbrella = json.loads(
                """{
                  "schemaVersion": 1,
                  "artifacts": [
                    {
                      "id": "android-cuttlefish-x86_64-zip",
                      "kind": "android-image",
                      "target": {"platform": "cuttlefish", "architecture": "x86_64", "device": "cf_x86_64_phone"},
                      "validation": {"evidence": []}
                    },
                    {
                      "id": "android-pixel-arm64-zip",
                      "kind": "android-image",
                      "target": {"platform": "android", "architecture": "arm64", "device": "pixel-supported"},
                      "validation": {
                        "evidence": [
                          {
                            "id": "android-pixel-arm64-launcher-agent-live",
                            "status": "missing",
                            "path": "evidence/android/pixel-arm64-launcher-agent-live.json"
                          }
                        ]
                      }
                    },
                    {
                      "id": "android-chip-riscv64-zip",
                      "kind": "android-image",
                      "target": {"platform": "eliza-chip", "architecture": "riscv64", "device": "eliza_ai_soc"},
                      "validation": {
                        "evidence": [
                          {
                            "id": "android-chip-riscv64-launcher-agent-live",
                            "status": "collected",
                            "path": "evidence/android/chip-riscv64-launcher-agent-live.json"
                          }
                        ]
                      }
                    }
                  ]
                }"""
            )
            write(
                tmp / "evidence/android/chip-riscv64-launcher-agent-live.json",
                '{"status":"missing"}\n',
            )
            with mock.patch.object(gate, "RELEASE_DIR", tmp):
                inventory = gate.live_launcher_agent_missing_evidence(umbrella)

        self.assertEqual(inventory["status"], "blocked")
        self.assertEqual(
            inventory["missingTargets"],
            [
                "android-cuttlefish-x86_64-zip",
                "android-pixel-arm64-zip",
                "android-chip-riscv64-zip",
            ],
        )
        by_id = {row["artifactId"]: row for row in inventory["records"]}
        self.assertEqual(by_id["android-cuttlefish-x86_64-zip"]["status"], "missing_row")
        self.assertIn(
            "evidence_file_missing=evidence/android/pixel-arm64-launcher-agent-live.json",
            by_id["android-pixel-arm64-zip"]["blockers"],
        )
        self.assertIn(
            "payload_status=missing",
            by_id["android-chip-riscv64-zip"]["blockers"],
        )
        self.assertFalse(by_id["android-chip-riscv64-zip"]["releaseCredit"])
        self.assertIn(
            str(tmp / "evidence/android/chip-riscv64-launcher-agent-live.json"),
            by_id["android-chip-riscv64-zip"]["expectedOutputFiles"],
        )
        self.assertIn(
            "--expected-artifact-id android-chip-riscv64-zip",
            by_id["android-chip-riscv64-zip"]["validationCommand"],
        )
        self.assertTrue(
            any(
                "--adb-connect" in command
                and "--expected-cpu-abi riscv64" in command
                and "--target-label chip-riscv64" in command
                for command in by_id["android-chip-riscv64-zip"]["collectionCommands"]
            )
        )

    def test_live_launcher_manifest_row_must_use_expected_target_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            umbrella = json.loads(
                """{
                  "schemaVersion": 1,
                  "artifacts": [
                    {
                      "id": "android-chip-riscv64-zip",
                      "kind": "android-image",
                      "target": {"platform": "eliza-chip", "architecture": "riscv64", "device": "eliza_ai_soc"},
                      "validation": {
                        "evidence": [
                          {
                            "id": "android-chip-riscv64-launcher-agent-live",
                            "status": "collected",
                            "path": "evidence/android/stale-chip-runtime.json"
                          }
                        ]
                      }
                    }
                  ]
                }"""
            )
            write(
                tmp / "evidence/android/stale-chip-runtime.json",
                PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
            )
            with mock.patch.object(gate, "RELEASE_DIR", tmp):
                inventory = gate.live_launcher_agent_missing_evidence(umbrella)
                invalid = gate.invalid_launcher_agent_payloads(umbrella["artifacts"][0])

        self.assertEqual(inventory["status"], "blocked")
        record = inventory["records"][0]
        self.assertEqual(record["status"], "blocked")
        self.assertFalse(record["releaseEvidencePathMatchesExpected"])
        self.assertIn(
            "row_path='evidence/android/stale-chip-runtime.json' expected_path='evidence/android/chip-riscv64-launcher-agent-live.json'",
            record["blockers"],
        )
        self.assertIn(
            "android-chip-riscv64-zip:android-chip-riscv64-launcher-agent-live:expected_path='evidence/android/chip-riscv64-launcher-agent-live.json'",
            invalid,
        )

    def test_real_chip_riscv64_release_with_launcher_agent_validation_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/android-partition-artifacts-integrity.json",
                    PASSING_PARTITION_INTEGRITY_PAYLOAD,
                )
                write(
                    Path(tmpdir) / "os/release/beta-2026-05-16/android/partitions/boot.img",
                    "boot-image\n",
                )
                write_android_archive(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip"
                )
                archive = (
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip"
                )
                archive_sha = gate.file_sha256(archive)
                archive_size = archive.stat().st_size
                umbrella = json.loads(PASSING_UMBRELLA_MANIFEST)
                umbrella["artifacts"][0]["sizeBytes"] = archive_size
                umbrella["artifacts"][0]["sha256"] = archive_sha
                gate.UMBRELLA_MANIFEST.write_text(json.dumps(umbrella), encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    json.dumps(
                        {
                            "status": "collected",
                            "artifact_id": "android-chip-riscv64-zip",
                            "filename": "elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "path": "android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "sha256": archive_sha,
                            "sizeBytes": archive_size,
                        }
                    )
                    + "\n",
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                with mock.patch.object(
                    gate,
                    "aosp_chip_build_artifact_inventory",
                    return_value=self._complete_aosp_chip_inventory(),
                ):
                    report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        assert_false_claim_flags(self, report)
        self.assertRegex(report["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")

    def test_staged_chip_archive_integrity_suppresses_stale_product_out_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/android-partition-artifacts-integrity.json",
                    PASSING_PARTITION_INTEGRITY_PAYLOAD,
                )
                write(
                    Path(tmpdir) / "os/release/beta-2026-05-16/android/partitions/boot.img",
                    "boot-image\n",
                )
                archive = write_android_archive(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip"
                )
                archive_sha = gate.file_sha256(archive)
                archive_size = archive.stat().st_size
                umbrella = json.loads(PASSING_UMBRELLA_MANIFEST)
                umbrella["artifacts"][0]["sizeBytes"] = archive_size
                umbrella["artifacts"][0]["sha256"] = archive_sha
                gate.UMBRELLA_MANIFEST.write_text(json.dumps(umbrella), encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    json.dumps(
                        {
                            "status": "collected",
                            "artifact_id": "android-chip-riscv64-zip",
                            "filename": "elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "path": "android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "sha256": archive_sha,
                            "sizeBytes": archive_size,
                        }
                    )
                    + "\n",
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                with mock.patch.object(
                    gate,
                    "aosp_chip_build_artifact_inventory",
                    return_value=self._partial_aosp_chip_inventory(),
                ):
                    report = gate.run_check(Namespace())

        codes = {finding["code"] for finding in report["findings"]}
        self.assertNotIn("android_chip_riscv64_aosp_artifacts_incomplete", codes)
        self.assertTrue(report["evidence"]["chip_riscv64_archive_staged_with_integrity"])
        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)

    def test_partial_aosp_chip_source_artifacts_are_explicit_repo_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            product_out = tmp / "out/target/product/eliza_ai_soc"
            write(product_out / "vendor.img", "vendor-image\n")
            write(product_out / "super.img.bak", "backup-super\n")
            build_report = write(
                tmp / "eliza-build-report.json",
                '{"result_code":1,"product_out_dir":"/tmp/out"}\n',
            )
            build_log = write(
                tmp / "eliza-build.log",
                (
                    "first line\n"
                    "[  7% 3117/42618 10h30m54s remaining] compile action\n"
                    "FAILED: out/target/product/eliza_ai_soc/system.img\n"
                    "last failure line\n"
                ),
            )
            write(product_out / "system/bin/app_process", "intermediate-system-file\n")
            write(product_out / "installed-files-system.txt", "system/bin/app_process\n")
            os.utime(build_report, (100, 100))
            os.utime(build_log, (200, 200))

            with mock.patch.object(gate, "active_aosp_build_processes", return_value=""):
                inventory = gate.aosp_chip_build_artifact_inventory(
                    product_out, build_report, build_log
                )

        self.assertEqual(inventory["status"], "partial")
        self.assertEqual(inventory["present"], ["vendor.img"])
        self.assertEqual(
            inventory["missing"],
            ["system.img", "product.img", "system_ext.img"],
        )
        self.assertEqual(inventory["blocker_dependency"], "repo_artifact_generation")
        self.assertEqual(
            inventory["latestBuildAttempt"]["buildReport"]["result_code"],
            1,
        )
        self.assertEqual(
            inventory["latestBuildAttempt"]["buildReportStaleComparedToLog"],
            True,
        )
        self.assertEqual(inventory["latestBuildAttempt"]["buildReportCredit"], False)
        self.assertIn(
            "last failure line",
            inventory["latestBuildAttempt"]["buildLogProgress"]["logFile"]["tail"],
        )
        self.assertEqual(
            inventory["latestBuildAttempt"]["buildLogProgress"]["lastProgressPercent"],
            7,
        )
        self.assertEqual(
            inventory["latestBuildAttempt"]["buildLogProgress"]["lastProgressCompletedActions"],
            3117,
        )
        self.assertIn(
            "FAILED: out/target/product/eliza_ai_soc/system.img",
            inventory["latestBuildAttempt"]["buildLogProgress"]["recentFailureLines"],
        )
        system_tree = {row["name"]: row for row in inventory["partialProductTrees"]}["system"]
        self.assertEqual(system_tree["releaseCredit"], False)
        self.assertEqual(system_tree["fileCount"], 1)
        self.assertEqual(system_tree["installedFilesList"]["exists"], True)
        self.assertEqual(
            inventory["nonReleaseImageCandidates"][0]["releaseCredit"],
            False,
        )
        self.assertIn(
            "build-aosp-riscv64.sh",
            inventory["latestBuildAttempt"]["generationCommands"]["directIncrementalBuild"],
        )
        self.assertIn(
            "systemextimage",
            inventory["latestBuildAttempt"]["generationCommands"]["imageOnlyResumeFromCurrentTree"],
        )

    def test_missing_android_archive_source_members_are_external_dependency(self) -> None:
        inventory = {
            "records": [
                {
                    "artifactId": "android-cuttlefish-x86_64-zip",
                    "readyToArchive": False,
                    "sourceDirectory": "/home/shaw/aosp/out/target/product/vsoc_x86_64_only",
                    "missingMembers": ["boot.img"],
                }
            ]
        }

        self.assertEqual(
            gate.android_archive_source_dependency(inventory),
            "actionable_external_dependency",
        )

    def test_complete_android_archive_source_members_remain_repo_generation(self) -> None:
        inventory = {
            "records": [
                {
                    "artifactId": "android-chip-riscv64-zip",
                    "readyToArchive": True,
                    "sourceDirectory": "/home/shaw/aosp/out/target/product/eliza_ai_soc",
                    "missingMembers": [],
                }
            ]
        }

        self.assertEqual(
            gate.android_archive_source_dependency(inventory),
            "repo_artifact_generation",
        )

    def test_android_archive_source_next_step_names_missing_members(self) -> None:
        inventory = {
            "records": [
                {
                    "artifactId": "android-cuttlefish-x86_64-zip",
                    "readyToArchive": False,
                    "sourceDirectory": "$AOSP_WORKSPACE/out/target/product/vsoc_x86_64_only",
                    "missingMembers": ["android-info.txt", "boot.img"],
                }
            ]
        }

        next_step = gate.android_archive_source_next_step(inventory)

        self.assertIn("No release archive should be generated", next_step)
        self.assertIn("android-cuttlefish-x86_64-zip", next_step)
        self.assertIn("android-info.txt, boot.img", next_step)

    def test_build_only_stage_logs_distinguish_timeout_from_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            lunch = write(
                tmp / "lunch.log",
                "COMMAND=lunch target\nSTART_UTC=2026-05-23T00:00:00Z\n"
                "END_UTC=2026-05-23T00:00:01Z\nRESULT=0\n",
            )
            vendorimage = write(
                tmp / "vendorimage.log",
                "COMMAND=m vendorimage\nSTART_UTC=2026-05-23T00:00:02Z\nRunning globs...\n",
            )
            with mock.patch.object(
                gate,
                "AOSP_BUILD_ONLY_EVIDENCE_LOGS",
                {"lunch": lunch, "vendorimage": vendorimage, "checkvintf": tmp / "missing.log"},
            ):
                inventory = gate.aosp_build_only_evidence_inventory()

        self.assertEqual(inventory["status"], "incomplete")
        self.assertEqual(inventory["passedStages"], ["lunch"])
        self.assertEqual(inventory["incompleteStages"], ["vendorimage"])
        self.assertEqual(inventory["missingStages"], ["checkvintf"])
        self.assertEqual(
            inventory["stages"]["vendorimage"]["status"],
            "incomplete_or_timed_out",
        )
        self.assertEqual(inventory["stages"]["vendorimage"]["releaseCredit"], False)

    def test_image_only_resume_logs_capture_timeout_target_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            log = write(
                tmp / "eliza_ai_soc_image_only_resume_20260523T081825Z.log",
                (
                    "COMMAND=m -j4 systemimage productimage systemextimage\n"
                    "START_UTC=2026-05-23T08:18:25Z\n"
                    "Running globs...\n"
                    "01:33:25 Got signal: terminated\n"
                    "01:33:27 soong bootstrap failed with: exit status 143\n"
                    "FAILED: out/soong/build.eliza_openagent_ai_soc_phone.ninja\n"
                    "error: action cancelled when ninja exited\n"
                    "[timeout-wrapper] label=aosp-image-only-resume status=timeout "
                    "timeout_seconds=900 ended_at=2026-05-23T08:33:32Z\n"
                    "END_UTC=2026-05-23T08:33:33Z\n"
                    "RESULT=124\n"
                ),
            )

            attempt = gate.aosp_image_only_resume_attempt(log)
            inventory = gate.aosp_image_only_resume_inventory(tmp)

        self.assertEqual(attempt["status"], "timeout")
        self.assertEqual(attempt["result"], 124)
        self.assertEqual(attempt["releaseCredit"], False)
        self.assertEqual(attempt["timedOut"], True)
        self.assertEqual(attempt["wrapperLabel"], "aosp-image-only-resume")
        self.assertEqual(attempt["timeoutSeconds"], 900)
        self.assertEqual(attempt["soongGraphGenerationIncomplete"], True)
        self.assertEqual(attempt["reachedSoongGraphNinjaGeneration"], True)
        self.assertIn(
            "FAILED: out/soong/build.eliza_openagent_ai_soc_phone.ninja",
            attempt["terminalFailureLines"],
        )
        self.assertEqual(inventory["attemptCount"], 1)
        self.assertEqual(inventory["latestAttempt"]["path"], str(log))
        self.assertIn("systemimage", inventory["requiredTargets"])

    def test_image_only_resume_logs_capture_active_wrapper_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            log = write(
                tmp / "eliza_ai_soc_image_only_resume_20260523T085612Z_3600s.log",
                (
                    "COMMAND=m -j4 systemimage productimage systemextimage\n"
                    "[timeout-wrapper] label=aosp-image-only-resume-3600 "
                    "timeout_seconds=3600 started_at=2026-05-23T08:56:12.335504+00:00\n"
                    "[100% 1/1] bootstrap blueprint\n"
                    "Running globs...\n"
                ),
            )

            attempt = gate.aosp_image_only_resume_attempt(log)
            inventory = gate.aosp_image_only_resume_inventory(tmp)

        self.assertEqual(attempt["status"], "in_progress")
        self.assertEqual(attempt["result"], None)
        self.assertEqual(attempt["wrapperLabel"], "aosp-image-only-resume-3600")
        self.assertEqual(attempt["timeoutSeconds"], 3600)
        self.assertEqual(attempt["reachedSoongBootstrap"], True)
        self.assertEqual(attempt["releaseCredit"], False)
        self.assertEqual(inventory["status"], "in_progress")

    def test_collected_row_with_unresolved_evidence_payload_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    '{"status":"missing"}\n',
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("umbrella_android_artifacts_evidence_payloads_unresolved", codes)

    def test_missing_row_with_fail_closed_payload_uses_not_collected_blocker_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            write(
                tmp / "os/release/beta-2026-05-16/evidence/android/missing-live.json",
                '{"status":"missing"}\n',
            )
            artifact = {
                "id": "android-chip-riscv64-zip",
                "validation": {
                    "evidence": [
                        {
                            "id": "android-chip-riscv64-launcher-agent-live",
                            "status": "missing",
                            "path": "evidence/android/missing-live.json",
                        }
                    ]
                },
            }
            with mock.patch.object(
                gate,
                "RELEASE_DIR",
                tmp / "os/release/beta-2026-05-16",
            ):
                unresolved = gate.unresolved_evidence_file_payloads(artifact)
                not_collected = gate.unresolved_evidence_rows(artifact)

        self.assertEqual(unresolved, [])
        self.assertEqual(
            not_collected,
            [
                "android-chip-riscv64-zip:android-chip-riscv64-launcher-agent-live:missing:evidence/android/missing-live.json"
            ],
        )

    def test_archive_source_member_inventory_is_target_specific_and_not_release_credit(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            aosp = tmp / "aosp"
            for member in gate.ANDROID_ARCHIVE_REQUIRED_MEMBERS:
                write(aosp / "out/target/product/eliza_ai_soc" / member, f"{member}\n")
            write(aosp / "out/target/product/vsoc_x86_64_only/system.img", "system\n")

            with mock.patch.object(gate, "AOSP_WORKSPACE", aosp):
                inventory = gate.android_archive_source_member_inventory(
                    json.loads(PASSING_UMBRELLA_MANIFEST)
                )

            self.assertEqual(
                inventory["claimBoundary"],
                "local_aosp_archive_source_inventory_only_not_release_archive_integrity_or_runtime_evidence",
            )
            self.assertEqual(inventory["status"], "pass")
            chip = inventory["records"][0]
            self.assertEqual(chip["artifactId"], "android-chip-riscv64-zip")
            self.assertEqual(
                chip["sourceDirectory"],
                str(aosp / "out/target/product/eliza_ai_soc"),
            )
            self.assertIn("system_ext.img", chip["requiredMembers"])
            self.assertEqual(chip["missingMembers"], [])
            self.assertEqual(chip["readyToArchive"], True)
            self.assertEqual(chip["releaseCredit"], False)
            with mock.patch.object(gate, "AOSP_WORKSPACE", aosp):
                inventory = gate.android_archive_source_member_inventory(
                    json.loads(CURRENT_UMBRELLA_MANIFEST)
                )

            by_id = {row["artifactId"]: row for row in inventory["records"]}
            self.assertEqual(inventory["status"], "blocked")
            self.assertIn(
                "android-info.txt",
                by_id["android-cuttlefish-x86_64-zip"]["missingMembers"],
            )
            self.assertIn(
                "system_ext.img",
                by_id["android-cuttlefish-x86_64-zip"]["missingMembers"],
            )
            self.assertFalse(by_id["android-pixel-arm64-zip"]["sourceDirectoryExists"])
            self.assertIn("android-pixel-arm64-zip", inventory["incompleteArtifacts"])

    def test_artifact_integrity_payload_must_match_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"wrong.zip","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sizeBytes":1}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("umbrella_android_artifacts_integrity_payload_mismatch", codes)

    def test_staged_archive_integrity_inventory_checks_actual_zip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                archive = write_android_archive(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip"
                )
                archive_sha = gate.file_sha256(archive)
                archive_size = archive.stat().st_size
                umbrella = json.loads(PASSING_UMBRELLA_MANIFEST)
                umbrella["artifacts"][0]["sizeBytes"] = archive_size
                umbrella["artifacts"][0]["sha256"] = archive_sha
                gate.UMBRELLA_MANIFEST.write_text(json.dumps(umbrella), encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    json.dumps(
                        {
                            "status": "collected",
                            "artifact_id": "android-chip-riscv64-zip",
                            "filename": "elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "path": "android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                            "sha256": archive_sha,
                            "sizeBytes": archive_size,
                        }
                    )
                    + "\n",
                )
                inventory = gate.staged_android_archive_integrity_inventory(
                    json.loads(gate.UMBRELLA_MANIFEST.read_text(encoding="utf-8"))
                )

        self.assertEqual(inventory["status"], "pass")
        self.assertEqual(inventory["mismatches"], [])
        record = inventory["records"][0]
        self.assertEqual(record["actualSha256"], archive_sha)
        self.assertEqual(record["actualSizeBytes"], archive_size)
        self.assertEqual(record["missingMembers"], [])
        self.assertEqual(record["releaseCredit"], True)
        self.assertEqual(
            record["claimBoundary"],
            "staged_archive_static_integrity_only_not_boot_or_launcher_liveness",
        )

    def test_staged_archive_integrity_mismatch_blocks_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                    "not a zip\n",
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())

        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("staged_android_archive_integrity_mismatch", codes)
        inventory = report["evidence"]["staged_android_archive_integrity_inventory"]
        self.assertEqual(inventory["status"], "blocked")
        self.assertTrue(any("zip_unreadable" in row for row in inventory["mismatches"]))

    def test_partition_artifact_integrity_payload_must_match_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/android-partition-artifacts-integrity.json",
                    '{"status":"collected","artifacts":[{"partition":"boot","filename":"boot.img","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sizeBytes":1}]}\n',
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_partition_artifacts_integrity_payload_mismatch", codes)

    def test_launcher_agent_payload_must_prove_live_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    '{"schema":"eliza.android_release_launcher_agent_liveness.v1","status":"collected","artifact_id":"android-chip-riscv64-zip","observed":{"sys_boot_completed":true}}\n',
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn(
            "umbrella_android_artifacts_launcher_agent_payload_invalid",
            codes,
        )

    def test_runtime_host_symlink_findings_block_release_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    gate.LAUNCHER_RUNTIME_REPORT,
                    '{"status":"blocked","findings":[{"code":"launcher_permission_xml_host_symlink","evidence":"/system/etc/permissions/foo.xml -> /home/user/src/foo.xml"}]}\n',
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn(
            "android_runtime_evidence_contains_host_symlinked_system_inputs",
            codes,
        )

    def test_runtime_host_symlink_findings_catch_generic_host_symlink_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                write(
                    gate.SYSTEM_BRIDGE_REPORT,
                    (
                        '{"status":"blocked","findings":[{"code":"future_permission_probe",'
                        '"evidence":"/system/etc/permissions/foo.xml -> '
                        '/var/folders/build/src/foo.xml"}]}\n'
                    ),
                )
                findings = gate.host_symlink_runtime_findings()
        self.assertEqual(len(findings), 1)
        self.assertIn("future_permission_probe", findings[0])

    def test_release_manifest_launcher_package_must_match_staged_apk_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                write(
                    gate.ANDROID_APK_PAYLOAD_REPORT,
                    (
                        '{"status":"pass","evidence":{'
                        '"provenance_android_package":"ai.milady.milady",'
                        '"vendor_ro_elizaos_home":"ai.milady.milady"}}\n'
                    ),
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-artifact-integrity.json",
                    '{"status":"collected","artifact_id":"android-chip-riscv64-zip","filename":"elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sizeBytes":8192}\n',
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/evidence/android/chip-riscv64-launcher-agent-live.json",
                    PASSING_LAUNCHER_AGENT_LIVE_PAYLOAD,
                )
                write(
                    Path(tmpdir) / "os/release/beta-2026-05-16/android/partitions/boot.img",
                    "boot-image\n",
                )
                write(
                    Path(tmpdir)
                    / "os/release/beta-2026-05-16/android/archives/elizaos-beta-2026.05.16-android-eliza_ai_soc-riscv64.zip",
                    "archive\n",
                )
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        self.assertIn(
            "android_release_manifest_launcher_package_mismatch",
            {finding["code"] for finding in report["findings"]},
        )
        self.assertEqual(report["evidence"]["expected_android_package"], "ai.milady.milady")

    def test_report_provenance_sanitizer_strips_host_local_paths(self) -> None:
        payload = {
            "path": "/home/shaw/aosp/out/target/product/eliza_ai_soc/vendor.img",
            "repo": "/home/shaw/milady/eliza/packages/chip/docs/evidence/android/log.txt",
            "command": "AOSP_DIR=/home/shaw/aosp python3 /home/shaw/milady/eliza/packages/chip/scripts/check.py",
            "nested": ["/tmp/aosp/out/target/product/eliza_ai_soc/system.img"],
        }

        sanitized = gate.provenance_safe_value(payload)

        self.assertNotIn("/home/shaw", json.dumps(sanitized))
        self.assertNotIn("/tmp/aosp", json.dumps(sanitized))
        self.assertEqual(
            sanitized["path"],
            "$AOSP_WORKSPACE/out/target/product/eliza_ai_soc/vendor.img",
        )
        self.assertEqual(
            sanitized["repo"],
            "packages/chip/docs/evidence/android/log.txt",
        )

    def test_release_artifact_inventory_sidecar_is_provenance_safe(self) -> None:
        report = {
            "evidence": {
                "android_release_artifact_inventory": {"status": "blocked"},
                "android_archive_source_member_inventory": {
                    "records": [
                        {
                            "sourceDirectory": "/home/shaw/aosp/out/target/product/eliza_ai_soc",
                            "members": [
                                {
                                    "path": "/home/shaw/aosp/out/target/product/eliza_ai_soc/vendor.img"
                                }
                            ],
                        }
                    ]
                },
                "staged_android_archive_integrity_inventory": {},
            }
        }

        sidecar = gate.release_artifact_inventory_sidecar(report)
        encoded = json.dumps(sidecar, sort_keys=True)

        self.assertEqual(sidecar["schema"], "eliza.android_release_artifact_inventory.v3")
        self.assertEqual(sidecar["status"], "blocked")
        self.assertIn("generated_utc", sidecar)
        self.assertNotIn("/home/shaw", encoded)
        self.assertIn("$AOSP_WORKSPACE/out/target/product/eliza_ai_soc/vendor.img", encoded)


class PatchStack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
