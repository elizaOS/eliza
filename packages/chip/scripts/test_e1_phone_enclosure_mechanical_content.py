#!/usr/bin/env python3
"""Focused regressions for the E1 phone enclosure/mechanical content gate."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class E1PhoneEnclosureMechanicalContentTests(unittest.TestCase):
    def test_blocked_local_candidate_step_does_not_get_implicit_release_credit(self) -> None:
        parent = ROOT / "build/test-e1-phone-enclosure-mechanical-content"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as tmp_text:
            report_path = Path(tmp_text) / "enclosure-content-report.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_e1_phone_enclosure_mechanical_content.py",
                    "--report",
                    str(report_path),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["release_credit"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertFalse(report["summary"]["release_ready"])
        self.assertFalse(report["summary"]["candidate_release_credit"])
        self.assertEqual(
            report["routed_step_generation_plan"]["repo_generatable_release_step_count"],
            0,
        )
        self.assertFalse(report["routed_step_generation_plan"]["release_credit"])
        self.assertTrue(
            all(
                row["release_credit"] is False
                for row in report["routed_step_inventory"]["candidate_no_release_credit"]
            )
        )


if __name__ == "__main__":
    unittest.main()
