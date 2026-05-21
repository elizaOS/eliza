#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_report_freshness.py."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_report_freshness as freshness


class ChipOsReportFreshnessTests(unittest.TestCase):
    def test_missing_report_and_source_are_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/missing.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertFalse(row["present"])
        codes = {finding["code"] for finding in findings}
        self.assertIn("missing_report_demo", codes)
        self.assertIn("missing_report_source_demo", codes)

    def test_source_newer_than_report_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/scripts/demo.py"
            report = repo / "packages/chip/build/reports/demo.json"
            source.parent.mkdir(parents=True)
            report.parent.mkdir(parents=True)
            report.write_text("{}\n", encoding="utf-8")
            source.write_text("print('demo')\n", encoding="utf-8")
            now = time.time()
            os.utime(report, (now - 20, now - 20))
            os.utime(source, (now, now))
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/demo.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertTrue(row["stale"])
        self.assertEqual(findings[0]["code"], "stale_report_demo")

    def test_fresh_report_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            source = repo / "packages/chip/scripts/demo.py"
            report = repo / "packages/chip/build/reports/demo.json"
            source.parent.mkdir(parents=True)
            report.parent.mkdir(parents=True)
            source.write_text("print('demo')\n", encoding="utf-8")
            report.write_text("{}\n", encoding="utf-8")
            now = time.time()
            os.utime(source, (now - 20, now - 20))
            os.utime(report, (now, now))
            spec = freshness.ReportSpec(
                "demo",
                "packages/chip/build/reports/demo.json",
                ("packages/chip/scripts/demo.py",),
                "demo report",
            )
            with mock.patch.object(freshness, "REPO", repo):
                row, findings = freshness.row_for_spec(spec)
        self.assertFalse(row["stale"])
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
