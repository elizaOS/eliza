#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "docs/evidence/linux/linux-external-bsp-status.json"


class LinuxExternalBspReportTests(unittest.TestCase):
    def test_custom_report_path_keeps_tracked_evidence_unchanged(self) -> None:
        before = DEFAULT_REPORT.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "linux-external-bsp-status.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_linux_external_bsp.py",
                    "--report",
                    str(report),
                ],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stdout)
            self.assertIn("STATUS: BLOCKED linux.external_bsp_status", completed.stdout)
            self.assertTrue(report.is_file())
            self.assertEqual(DEFAULT_REPORT.read_bytes(), before)

            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema"], "eliza.linux_external_bsp_status.v1")
            self.assertEqual(payload["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
