#!/usr/bin/env python3
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/package_cross_probe.json"


class PackageCrossProbeReleaseTests(unittest.TestCase):
    def run_checker(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "scripts/check_package_cross_probe.py", *args],
            cwd=ROOT,
            check=False,
            text=True,
            capture_output=True,
        )

    def test_release_fails_closed_with_structured_blocked_report(self) -> None:
        result = self.run_checker("--release")

        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("STATUS: BLOCKED package/vendor padframe cross-probe", result.stdout)
        payload = json.loads(REPORT.read_text())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["mode"], "release")
        self.assertIs(payload["release_credit"], False)
        self.assertGreater(payload["summary"]["blockers"], 0)
        self.assertTrue(payload["release_unblock_action_inventory"])
        self.assertEqual(
            len(payload["release_artifact_contract"]),
            5,
        )
        contract = {
            row["artifact"]: row for row in payload["release_artifact_contract"]
        }
        self.assertIn("vendor_package_drawing", contract)
        self.assertFalse(contract["vendor_package_drawing"]["release_credit"])
        self.assertEqual(
            contract["vendor_package_drawing"]["validation_command"],
            "python3 scripts/check_package_cross_probe.py --release",
        )

    def test_preflight_keeps_local_scaffold_pass_but_reports_no_release_credit(self) -> None:
        result = self.run_checker()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("release evidence is blocked", result.stdout)
        payload = json.loads(REPORT.read_text())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["mode"], "preflight")
        self.assertIs(payload["summary"]["release_credit"], False)

    def test_action_inventory_names_vendor_and_bond_evidence(self) -> None:
        result = self.run_checker("--release")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

        payload = json.loads(REPORT.read_text())
        buckets = {
            row["bucket"]: row for row in payload["release_unblock_action_inventory"]
        }
        self.assertIn("vendor_package_drawing", buckets)
        self.assertIn("bond_diagram", buckets)
        self.assertIn("package_padframe_board_cross_probe", buckets)
        self.assertTrue(
            all(row["release_credit"] is False for row in payload["release_unblock_action_inventory"])
        )

    def test_report_separates_vendor_gaps_from_local_planning_evidence(self) -> None:
        result = self.run_checker("--release")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

        payload = json.loads(REPORT.read_text())
        classes = payload["summary"]["blocker_classes"]
        self.assertEqual(classes["package_pinout_padframe_mismatch"], 0)
        self.assertGreater(classes["missing_vendor_evidence"], 0)
        self.assertGreater(classes["present_local_planning_evidence"], 0)
        self.assertGreater(payload["summary"]["present_local_planning_evidence_count"], 0)
        self.assertGreater(payload["summary"]["release_credit_false_artifact_count"], 0)
        self.assertTrue(payload["present_local_planning_evidence"])
        self.assertTrue(payload["release_credit_false_artifacts"])
        self.assertTrue(
            all(row["release_use"] == "prohibited" for row in payload["release_credit_false_artifacts"])
        )


if __name__ == "__main__":
    unittest.main()
