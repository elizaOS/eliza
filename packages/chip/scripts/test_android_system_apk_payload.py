#!/usr/bin/env python3
"""Tests for scripts/check_android_system_apk_payload.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_android_system_apk_payload as gate  # noqa: E402


def make_apk(path: Path, entries: list[str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for entry in entries:
            zf.writestr(entry, "x")
    return path


class AndroidSystemApkPayloadTests(unittest.TestCase):
    def test_missing_riscv64_payload_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_apk(
                Path(tmpdir) / "Eliza.apk",
                [
                    "AndroidManifest.xml",
                    "assets/agent/agent-bundle.js",
                    "assets/agent/launch.sh",
                ],
            )
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        self.assertEqual(report["status"], "blocked")
        missing = report["evidence"]["missing_entries"]
        self.assertIn("assets/agent/llama-kernel-diagnostic.mjs", missing)
        self.assertIn("assets/agent/riscv64/bun", missing)

    def test_complete_static_payload_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            apk = make_apk(Path(tmpdir) / "Eliza.apk", list(gate.REQUIRED_ENTRIES) + [gate.PROVENANCE_ENTRY])
            report = gate.run_check(
                Namespace(apk=str(apk), allow_missing_aapt=True),
            )
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertTrue(report["evidence"]["has_llama_kernel_diagnostic"])


if __name__ == "__main__":
    unittest.main()
