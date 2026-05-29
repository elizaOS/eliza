#!/usr/bin/env python3
"""Focused tests for DRAM controller gate result handling."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock
import json

import check_dram_controller as gate


class DramControllerGateTests(unittest.TestCase):
    def test_missing_required_tests_block_passing_summary(self) -> None:
        sim_log = "INFO cocotb summary PASS=8 FAIL=0"

        with tempfile.TemporaryDirectory() as tmpdir:
            result_xml = Path(tmpdir) / "results.xml"
            result_xml.write_text(
                "<testsuite><testcase name='capacity_readback_matches_geometry'/></testsuite>",
                encoding="utf-8",
            )
            with mock.patch.object(gate, "COCOTB_NATIVE_RESULTS", (result_xml,)):
                missing = gate.missing_required_tests_from_cocotb_outputs(sim_log)
                self.assertIn("burst_write_read_back_across_row_boundary", missing)
                with self.assertRaises(ValueError):
                    gate.write_cocotb_result(sim_log)

    def test_all_required_tests_allow_summary_artifact(self) -> None:
        sim_log = "INFO cocotb summary PASS=8 FAIL=0\n" + "\n".join(gate.REQUIRED_TESTS)

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "dram_controller_cocotb_results.xml"
            with (
                mock.patch.object(gate, "COCOTB_NATIVE_RESULTS", ()),
                mock.patch.object(gate, "COCOTB_RESULT", output),
                mock.patch.object(gate, "ROOT", Path(tmpdir)),
            ):
                relpath = gate.write_cocotb_result(sim_log)

            self.assertEqual(relpath, "dram_controller_cocotb_results.xml")
            text = output.read_text(encoding="utf-8")
            self.assertIn('tests="8"', text)
            for test in gate.REQUIRED_TESTS:
                self.assertIn(f'name="{test}"', text)

    def test_failure_markers_block_summary_even_when_all_required_tests_are_named(self) -> None:
        sim_log = "INFO cocotb summary PASS=8 FAIL=1\n" + "\n".join(gate.REQUIRED_TESTS)

        with tempfile.TemporaryDirectory() as tmpdir:
            result_xml = Path(tmpdir) / "results.xml"
            result_xml.write_text(
                '<testsuite failures="1"><testcase name="capacity_readback_matches_geometry">'
                "<failure>failed</failure></testcase></testsuite>",
                encoding="utf-8",
            )
            with (
                mock.patch.object(gate, "COCOTB_NATIVE_RESULTS", (result_xml,)),
                mock.patch.object(gate, "ROOT", Path(tmpdir)),
            ):
                markers = gate.cocotb_failure_markers(sim_log)
                self.assertTrue(markers)
                with self.assertRaises(ValueError):
                    gate.write_cocotb_result(sim_log)

    def test_report_denies_unproven_memory_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            report = Path(tmpdir) / "dram_controller.json"
            with mock.patch.object(gate, "REPORT", report):
                gate.write_report("PASS", None, None, {"unit": "test"})

            payload = json.loads(report.read_text(encoding="utf-8"))

        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_memory_claim_allowed",
            "memory_bandwidth_claim_allowed",
            "lpddr_phy_claim_allowed",
            "silicon_capacity_claim_allowed",
            "uma_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)
        boundary = payload["claim_boundary"]
        self.assertIn("not Linux memory-sizing evidence", boundary)
        self.assertIn("memory-bandwidth evidence", boundary)
        self.assertIn("silicon-capacity", boundary)


if __name__ == "__main__":
    unittest.main()
