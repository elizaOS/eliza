#!/usr/bin/env python3
"""Regression tests for the antenna metadata fail-closed gate."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import check_antenna_metadata as gate  # noqa: E402


def assert_false_claim_flags(testcase: unittest.TestCase, payload: dict[str, object]) -> None:
    testcase.assertEqual(payload["claim_boundary"], gate.CLAIM_BOUNDARY)
    for key, expected in gate.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(payload.get(key), expected, key)


class AntennaMetadataBlockedStateTests(unittest.TestCase):
    def test_missing_openlane_report_is_blocked_exit_2_with_structured_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            report = root / "antenna_metadata.json"
            with (
                patch.object(gate, "RUNS", root / "runs"),
                patch.object(gate, "DERIVED_RUNS", root / "derived-runs"),
                patch.object(gate, "REPORT", report),
                patch.object(gate, "PADFRAME", root / "missing-padframe.yaml"),
                patch("sys.argv", ["check_antenna_metadata.py", "--release"]),
            ):
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = gate.main()

            self.assertEqual(exit_code, 2)
            self.assertIn("STATUS: BLOCKED", stdout.getvalue())
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema"], gate.SCHEMA)
            self.assertEqual(payload["status"], "blocked")
            assert_false_claim_flags(self, payload)
            self.assertFalse(payload["release_credit"])
            self.assertFalse(payload["summary"]["release_credit"])
            self.assertEqual(payload["summary"]["blockers"], 1)
            self.assertFalse(payload["summary"]["source_report_present"])
            self.assertEqual(
                payload["blocker_categories"],
                {"missing_openlane_antenna_metadata_report": 1},
            )
            self.assertIn(gate.ANTENNA_REPORT_GLOB, payload["report_search"]["globs"])
            self.assertIn(str(root / "runs"), payload["report_search"]["roots"])
            self.assertIn(str(root / "derived-runs"), payload["report_search"]["roots"])
            self.assertEqual(payload["findings"][0]["severity"], "blocker")

    def test_malformed_openlane_report_is_hard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "report.yaml"
            source.write_text("not: a list\n", encoding="utf-8")
            report = root / "antenna_metadata.json"
            with (
                patch.object(gate, "REPORT", report),
                patch(
                    "sys.argv", ["check_antenna_metadata.py", "--release", "--report", str(source)]
                ),
            ):
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = gate.main()

            self.assertEqual(exit_code, 1)
            self.assertIn("STATUS: FAIL", stdout.getvalue())
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "fail")
            assert_false_claim_flags(self, payload)
            self.assertEqual(payload["summary"]["failures"], 1)
            self.assertEqual(
                payload["blocker_categories"],
                {"malformed_openlane_antenna_metadata_report": 1},
            )

    def test_report_for_other_design_is_blocked_not_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "report.yaml"
            source.write_text(
                """
- cell: e1_pd_smoke_top
  input: []
  output: []
  inout: []
""".lstrip(),
                encoding="utf-8",
            )
            report = root / "antenna_metadata.json"
            with (
                patch.object(gate, "REPORT", report),
                patch.object(gate, "PADFRAME", root / "missing-padframe.yaml"),
                patch(
                    "sys.argv", ["check_antenna_metadata.py", "--release", "--report", str(source)]
                ),
            ):
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = gate.main()

            self.assertEqual(exit_code, 2)
            self.assertIn("STATUS: BLOCKED", stdout.getvalue())
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "blocked")
            self.assertEqual(
                payload["blocker_categories"],
                {"missing_e1_chip_top_antenna_metadata_report": 1},
            )
            self.assertTrue(payload["summary"]["source_report_missing_e1_chip_top"])
            self.assertEqual(payload["summary"]["missing_e1_chip_top_report_count"], 1)
            self.assertIn("Regenerate the OpenLane antenna metadata report", payload["findings"][0]["next_step"])

    def test_latest_report_accepts_any_openlane_step_number_and_derived_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            older = root / "runs" / "old" / "61-odb-checkdesignantennaproperties"
            newer = root / "derived-runs" / "new" / "58-odb-checkdesignantennaproperties"
            older.mkdir(parents=True)
            newer.mkdir(parents=True)
            older_report = older / "report.yaml"
            newer_report = newer / "report.yaml"
            older_report.write_text("- cell: e1_chip_top\n", encoding="utf-8")
            newer_report.write_text("- cell: e1_chip_top\n", encoding="utf-8")
            with (
                patch.object(gate, "RUNS", root / "runs"),
                patch.object(gate, "DERIVED_RUNS", root / "derived-runs"),
            ):
                os.utime(older_report, (1, 1))
                os.utime(newer_report, (2, 2))
                self.assertEqual(gate.latest_report(), newer_report)

    def test_missing_pin_report_records_actionable_buckets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "report.yaml"
            source.write_text(
                """
- cell: other
  input: [IGNORED]
- cell: e1_chip_top
  input: [JTAG_TCK, TEST_MODE]
  output: [JTAG_TDO]
  inout: [GPIO0]
""".lstrip(),
                encoding="utf-8",
            )
            padframe = root / "padframe.yaml"
            padframe.write_text(
                "release_gates:\n  padframe_release:\n    blocked: true\n",
                encoding="utf-8",
            )
            report = root / "antenna_metadata.json"
            with (
                patch.object(gate, "REPORT", report),
                patch.object(gate, "PADFRAME", padframe),
                patch(
                    "sys.argv", ["check_antenna_metadata.py", "--release", "--report", str(source)]
                ),
            ):
                stdout = StringIO()
                with redirect_stdout(stdout):
                    exit_code = gate.main()

            self.assertEqual(exit_code, 2)
            self.assertIn("STATUS: BLOCKED antenna metadata check", stdout.getvalue())
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "blocked")
            self.assertEqual(payload["summary"]["missing_pin_count"], 4)
            self.assertEqual(payload["summary"]["missing_input_gate_metadata_count"], 2)
            self.assertEqual(payload["summary"]["missing_output_diffusion_metadata_count"], 1)
            self.assertEqual(payload["summary"]["missing_inout_diffusion_metadata_count"], 1)
            self.assertTrue(payload["summary"]["padframe_release_blocked"])
            self.assertEqual(
                payload["blocker_categories"],
                {
                    "missing_input_gate_metadata": 2,
                    "missing_output_diffusion_metadata": 1,
                    "missing_inout_diffusion_metadata": 1,
                    "padframe_release_blocked": 1,
                },
            )
            self.assertEqual(payload["missing_metadata"]["input"], ["JTAG_TCK", "TEST_MODE"])


if __name__ == "__main__":
    unittest.main()
