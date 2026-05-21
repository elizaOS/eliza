#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_boot_gap_inventory.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import check_chip_os_boot_gap_inventory as inv


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


class ChipOsBootGapInventoryTests(unittest.TestCase):
    def test_inventory_collects_nonpass_gates_and_detailed_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(
                aggregate,
                {
                    "gates": [
                        {
                            "name": "linux-boot",
                            "status": "BLOCKED",
                            "subsystem": "bsp",
                            "tier": "silicon",
                            "evidence": "missing Linux boot",
                        },
                        {
                            "name": "os-release",
                            "status": "FAIL",
                            "subsystem": "os",
                            "tier": "spec",
                            "evidence": "traceback",
                        },
                        {"name": "agent", "status": "PASS"},
                    ]
                },
            )
            write_json(
                report_dir / "linux_boot.json",
                {
                    "status": "blocked",
                    "findings": [
                        {
                            "code": "missing_chip_boot_evidence",
                            "severity": "blocker",
                            "message": "chip boot evidence missing",
                            "evidence": "linux.log",
                            "next_step": "capture boot",
                        }
                    ],
                },
            )
            args = inv.parse_args(
                [
                    "--aggregate",
                    str(aggregate),
                    "--report-dir",
                    str(report_dir),
                    "--report",
                    str(root / "inventory.json"),
                ]
            )
            report, exit_code = inv.build_inventory(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["nonpassing_aggregate_gates"], 2)
        self.assertEqual(report["summary"]["blocked_aggregate_gates"], 1)
        self.assertEqual(report["summary"]["failed_aggregate_gates"], 1)
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 1)
        self.assertIn("missing_chip_boot_evidence", report["detailed_blocker_codes"])
        covered = {
            row["name"]: row["has_detailed_report"]
            for row in report["aggregate_gate_detail_coverage"]
        }
        self.assertTrue(covered["linux-boot"])
        self.assertFalse(covered["os-release"])
        self.assertIn("aggregate_fail_os_release", report["detailed_blocker_codes"])

    def test_missing_inputs_return_blocked_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            args = inv.parse_args(
                [
                    "--aggregate",
                    str(Path(tmp) / "missing.json"),
                    "--report-dir",
                    str(Path(tmp) / "missing-reports"),
                ]
            )
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 2)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(len(report["sources"]["missing"]), 2)
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)

    def test_string_blockers_and_nonpass_status_become_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(report_dir / "a.json", {"status": "blocked", "blockers": ["AOSP boot absent"]})
            write_json(report_dir / "b.json", {"status": "blocked", "reason": "No launcher trace"})
            args = inv.parse_args(
                ["--aggregate", str(aggregate), "--report-dir", str(report_dir)]
            )
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["detailed_blocker_entries"], 2)
        self.assertIn("aosp_boot_absent", report["detailed_blocker_codes"])
        self.assertIn("no_launcher_trace", report["detailed_blocker_codes"])

    def test_gate_specs_add_script_and_expected_report_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(
                aggregate,
                {
                    "gates": [
                        {
                            "name": "android-app-runtime-contract-check",
                            "status": "BLOCKED",
                            "subsystem": "bsp",
                            "tier": "spec",
                            "evidence": "STATUS: BLOCKED android_app.runtime_contract",
                        }
                    ]
                },
            )
            write_json(
                report_dir / "android_app_runtime_contract.json",
                {
                    "status": "blocked",
                    "findings": [{"code": "apk_missing_riscv64", "severity": "blocker"}],
                },
            )
            args = inv.parse_args(
                ["--aggregate", str(aggregate), "--report-dir", str(report_dir)]
            )
            report, _ = inv.build_inventory(args)
        coverage = report["aggregate_gate_detail_coverage"][0]
        self.assertEqual(coverage["source_script"], "scripts/check_android_app_runtime_contract.py")
        self.assertIn("android_app_runtime_contract.json", coverage["expected_report_candidates"])
        self.assertEqual(
            coverage["matched_detail_reports"],
            [str(report_dir / "android_app_runtime_contract.json")],
        )
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)


if __name__ == "__main__":
    unittest.main()
