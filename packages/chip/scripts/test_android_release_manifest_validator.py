#!/usr/bin/env python3
"""Tests for the Android release manifest validator evidence writer."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = ROOT / "packages/os/android/installer/scripts/validate-release-manifest.mjs"


def write_manifest(path: Path, sha256: str, size: int) -> None:
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "releaseId": "elizaos-android-test",
                "generatedAt": "2026-05-22T00:00:00Z",
                "buildFingerprint": "elizaos/test/test:16/test:userdebug/test-keys",
                "buildType": "userdebug",
                "supportedDevices": [
                    {
                        "codename": "eliza_ai_soc_riscv64",
                        "marketingName": "Eliza AI SoC",
                        "tier": "blocked",
                        "slots": ["a", "b"],
                        "dynamicPartitions": True,
                        "rollbackSupported": True,
                    }
                ],
                "artifacts": [
                    {
                        "partition": "boot",
                        "filename": "boot.img",
                        "sha256": sha256,
                        "sizeBytes": size,
                        "required": True,
                        "fastbootMode": "bootloader",
                    }
                ],
                "validation": {
                    "bootTimeoutSeconds": 300,
                    "properties": {"sys.boot_completed": "1"},
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


class AndroidReleaseManifestValidatorTests(unittest.TestCase):
    def test_write_evidence_blocks_when_artifact_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "android-release-manifest.json"
            evidence = tmp / "evidence/android/android-partition-artifacts-integrity.json"
            write_manifest(manifest, "a" * 64, 4096)

            result = subprocess.run(
                [
                    "node",
                    str(VALIDATOR),
                    str(manifest),
                    "--artifact-dir",
                    str(tmp / "partitions"),
                    "--write-evidence",
                    str(evidence),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            payload = json.loads(evidence.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "blocked")
            self.assertEqual(payload["artifacts"][0]["status"], "missing")
            self.assertIn("artifact file not found", payload["errors"][0])

    def test_write_evidence_passes_when_artifact_matches_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            artifact_dir = tmp / "partitions"
            artifact_dir.mkdir()
            artifact = artifact_dir / "boot.img"
            artifact.write_bytes(b"real boot image bytes")
            sha256 = subprocess.check_output(
                ["sha256sum", str(artifact)],
                text=True,
            ).split()[0]
            manifest = tmp / "android-release-manifest.json"
            evidence = tmp / "evidence/android/android-partition-artifacts-integrity.json"
            write_manifest(manifest, sha256, artifact.stat().st_size)

            result = subprocess.run(
                [
                    "node",
                    str(VALIDATOR),
                    str(manifest),
                    "--artifact-dir",
                    str(artifact_dir),
                    "--write-evidence",
                    str(evidence),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(evidence.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "pass")
            self.assertEqual(payload["artifacts"][0]["status"], "verified")
            self.assertEqual(payload["artifacts"][0]["sha256"], sha256)


if __name__ == "__main__":
    unittest.main()
