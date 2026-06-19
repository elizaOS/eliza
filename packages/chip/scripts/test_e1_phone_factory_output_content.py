#!/usr/bin/env python3
"""Focused regressions for the E1 phone factory-output content gate."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_e1_phone_factory_output_content as factory_content  # noqa: E402


class E1PhoneFactoryOutputContentTests(unittest.TestCase):
    def test_blocked_local_candidates_do_not_get_implicit_release_credit(self) -> None:
        parent = ROOT / "build/test-e1-phone-factory-output-content"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as tmp_text:
            report_path = Path(tmp_text) / "factory-content-report.json"
            with mock.patch.object(factory_content, "REPORT", report_path):
                self.assertEqual(factory_content.main(), 2)
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["release_credit"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertFalse(report["summary"]["release_ready"])
        self.assertGreater(report["summary"]["candidate_present_but_blocked_count"], 0)
        self.assertEqual(report["summary"]["true_missing_factory_output_count"], 0)
        self.assertFalse(report["candidate_manifest_coverage"]["candidate_release_credit"])
        self.assertTrue(
            all(row["release_credit"] is False for row in report["blocked_evidence_inventory"])
        )


if __name__ == "__main__":
    unittest.main()
