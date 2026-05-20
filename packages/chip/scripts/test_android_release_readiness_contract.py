#!/usr/bin/env python3
"""Tests for scripts/check_android_release_readiness_contract.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_release_readiness_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
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
      "sizeBytes": 8192,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "validation": {
        "requiredEvidence": ["assistant-role-validation", "agent-health-smoke"],
        "evidence": ["evidence/android/chip-riscv64-launcher-agent.json"]
      }
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
            mock.patch.object(gate, "ANDROID_MANIFEST", android_manifest),
            mock.patch.object(gate, "UMBRELLA_MANIFEST", umbrella_manifest),
            mock.patch.object(gate, "POST_FLASH", post_flash),
            mock.patch.object(gate, "INSTALLER", installer),
        ]
        return patches

    def test_placeholder_release_manifests_and_thin_validators_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_release_manifest_uses_placeholder_hashes", codes)
        self.assertIn("android_release_manifest_uses_sentinel_sizes", codes)
        self.assertIn("android_release_manifest_missing_chip_riscv64_target", codes)
        self.assertIn("android_release_validation_missing_launcher_agent_checks", codes)
        self.assertIn("post_flash_validator_missing_launcher_agent_checks", codes)
        self.assertIn("installer_reboot_validation_missing_launcher_agent_checks", codes)
        self.assertIn("umbrella_android_artifacts_missing_integrity", codes)
        self.assertIn("umbrella_android_artifacts_missing_evidence", codes)
        self.assertIn("umbrella_missing_android_riscv64_chip_artifact", codes)

    def test_real_chip_riscv64_release_with_launcher_agent_validation_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.ANDROID_MANIFEST.write_text(PASSING_ANDROID_MANIFEST, encoding="utf-8")
                gate.UMBRELLA_MANIFEST.write_text(PASSING_UMBRELLA_MANIFEST, encoding="utf-8")
                gate.POST_FLASH.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                gate.INSTALLER.write_text(FULL_VALIDATOR_SCRIPT, encoding="utf-8")
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)


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
