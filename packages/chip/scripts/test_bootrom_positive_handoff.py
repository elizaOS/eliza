#!/usr/bin/env python3
"""Tests for scripts/check_bootrom_positive_handoff.py."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_bootrom_positive_handoff as gate  # noqa: E402

CAPTURE = ROOT / "scripts/capture_bootrom_positive_handoff.sh"


class BootromPositiveHandoffTests(unittest.TestCase):
    def _patch_paths(self, tmp: Path):
        return [
            mock.patch.object(gate, "CHIP_ROOT", tmp),
            mock.patch.object(
                gate,
                "TRANSCRIPT",
                tmp / "docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt",
            ),
            mock.patch.object(
                gate,
                "REPORT_PATH",
                tmp / "build/reports/gate-bootrom-positive-handoff-check.json",
            ),
        ]

    def test_missing_transcript_writes_blocked_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_paths(Path(tmpdir))):
            rc = gate.main()
            report = json.loads(gate.REPORT_PATH.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["blocker_id"], gate.BLOCKER_ID)
        self.assertEqual(report["evidence_paths"], [])
        for key in (
            "claim_allowed",
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_boot_claim_allowed",
            "android_boot_claim_allowed",
            "silicon_secure_boot_claim_allowed",
        ):
            self.assertIs(report.get(key), False)
        self.assertEqual(
            {key for key, value in report["false_claim_flags"].items() if value is False},
            set(report["false_claim_flags"]),
        )
        self.assertEqual(
            {check["status"] for check in report["checks"]},
            {"blocked"},
        )
        self.assertEqual(report["capture_preflight"]["status"], "blocked")
        self.assertFalse(report["capture_preflight"]["command_configured"])
        self.assertEqual(report["summary"]["next_command_batch_count"], 1)
        self.assertEqual(report["next_command_plan"][0]["id"], "capture_bootrom_positive_handoff")
        self.assertIn(
            "ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD",
            " ".join(report["next_command_plan"][0]["commands"]),
        )

    def test_missing_marker_blocks_even_with_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_paths(Path(tmpdir))):
            gate.TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
            gate.TRANSCRIPT.write_text(
                "## claim_boundary: provisioned_test_root_signed_image_simulator_only_not_silicon_attestation\n"
                "## command_exit_code: 0\n"
                "reset-vector-fetch <_start>\n"
                "<e1_secure_boot_main>\n"
                "authenticated-image-verified\n",
                encoding="utf-8",
            )
            rc = gate.main()
            report = json.loads(gate.REPORT_PATH.read_text(encoding="utf-8"))

        self.assertEqual(rc, 1)
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["capture_preflight"]["status"], "blocked")
        self.assertEqual(report["summary"]["next_command_batch_count"], 1)
        self.assertTrue(report["next_command_plan"])
        failed = {check["id"] for check in report["checks"] if check["status"] != "pass"}
        self.assertEqual(
            failed,
            {"handoff_target_loaded_from_manifest", "opensbi_entry_reached"},
        )
        self.assertEqual(
            report["evidence_paths"], [gate.TRANSCRIPT.relative_to(gate.CHIP_ROOT).as_posix()]
        )

    def test_complete_transcript_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_paths(Path(tmpdir))):
            gate.TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
            gate.TRANSCRIPT.write_text(
                "## claim_boundary: provisioned_test_root_signed_image_simulator_only_not_silicon_attestation\n"
                "## command_exit_code: 0\n"
                "reset-vector-fetch <_start>\n"
                "<e1_secure_boot_main>\n"
                "authenticated-image-verified\n"
                "handoff-target-loaded-from-manifest 0x80200000\n"
                "OpenSBI entry reached\n",
                encoding="utf-8",
            )
            rc = gate.main()
            report = json.loads(gate.REPORT_PATH.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(report["status"], "PASS")
        self.assertIsNone(report["blocker_id"])
        for key in (
            "claim_allowed",
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_boot_claim_allowed",
            "android_boot_claim_allowed",
            "silicon_secure_boot_claim_allowed",
        ):
            self.assertIs(report.get(key), False)
        self.assertEqual(
            {check["status"] for check in report["checks"]},
            {"pass"},
        )
        self.assertEqual(
            {key for key, value in report["false_claim_flags"].items() if value is False},
            set(report["false_claim_flags"]),
        )
        self.assertEqual(report["summary"]["next_command_batch_count"], 0)
        self.assertEqual(report["next_command_plan"], [])

    def test_marker_only_transcript_without_capture_provenance_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, PatchStack(self._patch_paths(Path(tmpdir))):
            gate.TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
            gate.TRANSCRIPT.write_text(
                "reset-vector-fetch <_start>\n"
                "<e1_secure_boot_main>\n"
                "authenticated-image-verified\n"
                "handoff-target-loaded-from-manifest 0x80200000\n"
                "OpenSBI entry reached\n",
                encoding="utf-8",
            )
            rc = gate.main()
            report = json.loads(gate.REPORT_PATH.read_text(encoding="utf-8"))

        self.assertEqual(rc, 1)
        failed = {check["id"] for check in report["checks"] if check["status"] != "pass"}
        self.assertEqual(
            failed,
            {"capture_claim_boundary_recorded", "capture_command_exit_zero"},
        )

    def test_capture_wrapper_blocks_without_real_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            transcript = tmp / "positive.log"
            report = tmp / "positive.json"
            env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("ELIZA_BOOTROM_POSITIVE_HANDOFF_")
            }
            env["ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT"] = str(transcript)
            env["ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT"] = str(report)
            result = subprocess.run(
                [str(CAPTURE), "preflight"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                env=env,
            )

            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn(
                "STATUS: BLOCKED bootrom.positive_handoff_capture_preflight", result.stdout
            )
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "BLOCKED")
            self.assertEqual(payload["evidence_paths"], [])
            self.assertEqual(payload["capture_preflight"]["status"], "blocked")
            self.assertTrue(payload["next_command_plan"])

    def test_capture_wrapper_validates_emitted_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            transcript = tmp / "positive.log"
            report = tmp / "positive.json"
            env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("ELIZA_BOOTROM_POSITIVE_HANDOFF_")
            }
            env["ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT"] = str(transcript)
            env["ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT"] = str(report)
            env["ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD"] = (
                "printf '%s\\n' "
                "'reset-vector-fetch <_start>' "
                "'<e1_secure_boot_main>' "
                "'authenticated-image-verified' "
                "'handoff-target-loaded-from-manifest 0x80200000' "
                "'OpenSBI entry reached'"
            )
            result = subprocess.run(
                [str(CAPTURE), "run"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                env=env,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS: bootrom positive handoff gate", result.stdout)
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "PASS")
            self.assertEqual({check["status"] for check in payload["checks"]}, {"pass"})
            self.assertEqual(payload["next_command_plan"], [])


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
