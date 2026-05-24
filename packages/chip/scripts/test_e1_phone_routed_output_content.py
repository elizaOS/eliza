#!/usr/bin/env python3
"""Focused regressions for the E1 phone routed-output content gate."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_e1_phone_routed_output_content as routed_content  # noqa: E402


class E1PhoneRoutedOutputContentTests(unittest.TestCase):
    def test_checker_reports_blocked_inventory_without_release_credit(self) -> None:
        report_path = ROOT / "build/reports/e1_phone_routed_output_content.focused.json"
        completed = subprocess.run(
            [
                sys.executable,
                "scripts/check_e1_phone_routed_output_content.py",
                "--report",
                str(report_path),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn("STATUS: BLOCKED E1 phone routed-output content", combined)
        self.assertIn("content_valid=", combined)

        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["release_credit"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertFalse(report["summary"]["release_ready"])
        self.assertIn("true_missing_generated_output_count", report["summary"])
        self.assertIn("missing_approval_metadata_count", report["summary"])
        self.assertIn("candidate_present_but_blocked_count", report["summary"])
        self.assertIn("release_credit_false_count", report["summary"])
        self.assertEqual(report["summary"]["true_missing_generated_output_count"], 0)
        self.assertEqual(report["summary"]["missing_approval_metadata_count"], 0)
        self.assertGreater(report["summary"]["candidate_present_but_blocked_count"], 0)
        self.assertIn("repo_generated_candidate_blocked_count", report["summary"])
        self.assertIn("external_release_evidence_required_count", report["summary"])
        self.assertEqual(
            report["summary"]["release_credit_false_count"],
            report["summary"]["blocked"],
        )
        self.assertFalse(report["candidate_manifest_coverage"]["candidate_release_credit"])
        self.assertEqual(
            len(report["routed_execution_packet_inventory"]),
            report["summary"]["blocked"],
        )
        self.assertGreater(len(report["routed_execution_packet_inventory"]), 0)
        self.assertTrue(
            all(
                packet["release_credit"] is False
                for packet in report["routed_execution_packet_inventory"]
            )
        )
        categories = report["routed_output_blocker_categories"]
        self.assertFalse(categories["release_credit"])
        self.assertEqual(
            sum(categories["counts"].values()),
            report["summary"]["blocked"],
        )
        self.assertEqual(categories["counts"]["true_missing_generated_outputs"], 0)
        self.assertEqual(categories["counts"]["missing_approval_metadata"], 0)
        self.assertEqual(
            categories["release_credit_false_artifacts"]["count"],
            report["summary"]["blocked"],
        )
        self.assertGreater(categories["counts"]["present_unapproved_or_placeholder"], 0)
        self.assertGreater(categories["counts"]["candidate_present_but_blocked"], 0)
        stackup_category = categories["by_path"][
            "board/kicad/e1-phone/production/stackup"
        ]
        self.assertEqual(stackup_category["category"], "present_unapproved_or_placeholder")
        self.assertTrue(stackup_category["release_credit_false"])
        self.assertIn("failure_buckets", stackup_category)
        self.assertIn("candidate_fail_closed_metadata", stackup_category)
        self.assertIn("required_metadata_record", stackup_category)
        self.assertFalse(stackup_category["release_credit"])
        generation = report["repo_generation_summary"]
        self.assertFalse(generation["release_credit"])
        self.assertEqual(
            generation["true_missing_generated_artifact_count"],
            report["summary"]["true_missing_generated_output_count"],
        )
        self.assertGreater(generation["generator_command_available_count"], 0)
        self.assertEqual(
            generation["external_release_evidence_required_count"],
            report["summary"]["blocked"],
        )
        self.assertIn(
            "generate_e1_phone_routed_output_candidates.py",
            generation["generator_command"],
        )
        self.assertIn("repo_generation_plan", stackup_category)

    def test_contract_error_returns_blocked_report_not_failure(self) -> None:
        parent = ROOT / "build/test-e1-phone-routed-output-content"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as tmp_text:
            tmp = Path(tmp_text)
            matrix = tmp / "bad-routed-matrix.yaml"
            report_path = tmp / "routed-content-report.json"
            matrix.write_text("schema: wrong.schema\nsummary: {}\n", encoding="utf-8")
            with (
                mock.patch.object(routed_content, "MATRIX", matrix),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "check_e1_phone_routed_output_content.py",
                        "--report",
                        str(report_path),
                    ],
                ),
            ):
                self.assertEqual(routed_content.main(), 2)
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["release_credit"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertFalse(report["summary"]["release_ready"])
        self.assertIn("routed_execution_packet_inventory", report)
        self.assertEqual(report["routed_execution_packet_inventory"], [])
        self.assertEqual(report["findings"][0]["code"], "routed_output_contract_blocked")


if __name__ == "__main__":
    unittest.main()
