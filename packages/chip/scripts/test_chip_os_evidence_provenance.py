#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_evidence_provenance.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_evidence_provenance as provenance


class ChipOsEvidenceProvenanceTests(unittest.TestCase):
    def test_detects_host_path_reference_scope_and_missing_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "blocked",
                        "claim_boundary": "qemu_virt_reference_only_not_chip_boot",
                        "path": "/home/shaw/demo/artifact.log",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        categories = data["summary"]["categories"]
        self.assertGreaterEqual(categories["host_local_path"], 1)
        self.assertGreaterEqual(categories["weak_reference_scope"], 1)
        self.assertGreaterEqual(categories["missing_timestamp"], 1)
        self.assertGreaterEqual(categories["nonpassing_status"], 1)
        self.assertEqual(
            data["scan_root_summary"][0]["root"],
            "packages/chip/build/reports",
        )

    def test_passes_clean_timestamped_structured_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "pass",
                        "claim_boundary": "runtime evidence for selected chip emulator",
                        "generated_utc": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_default_roots_cover_os_android_release_and_app_payload_manifests(self) -> None:
        expected = {
            "packages/chip/build/reports",
            "packages/chip/docs/evidence",
            "packages/os/linux/elizaos/evidence",
            "packages/os/android/installer/manifests",
            "packages/os/android/vendor/eliza/manifests",
            "packages/os/release/beta-2026-05-16",
            "packages/os/release/confidential-2026-05-21",
            "packages/app/android/app/src/main/assets/agent/plugins-manifest.json",
        }
        self.assertTrue(expected.issubset(set(provenance.DEFAULT_SCAN_ROOTS)))


if __name__ == "__main__":
    unittest.main()
