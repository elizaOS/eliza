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

    def test_matching_pass_report_for_nonpass_gate_is_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(
                aggregate,
                {
                    "gates": [
                        {
                            "name": "linux-bsp-contract-check",
                            "status": "BLOCKED",
                            "subsystem": "bsp",
                            "tier": "spec",
                            "evidence": "STATUS: BLOCKED linux.bsp_contract",
                        }
                    ]
                },
            )
            write_json(report_dir / "linux_bsp_contract.json", {"status": "pass", "findings": []})
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, _ = inv.build_inventory(args)
        coverage = report["aggregate_gate_detail_coverage"][0]
        self.assertFalse(coverage["has_detailed_report"])
        self.assertEqual(
            coverage["mismatched_detail_reports"], [str(report_dir / "linux_bsp_contract.json")]
        )
        self.assertIn(
            "detail_report_mismatch_linux_bsp_contract_check",
            report["detailed_blocker_codes"],
        )
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 1)

    def test_string_blockers_and_nonpass_status_become_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "a.json", {"status": "blocked", "blockers": ["AOSP boot absent"]}
            )
            write_json(report_dir / "b.json", {"status": "blocked", "reason": "No launcher trace"})
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["detailed_blocker_entries"], 2)
        self.assertIn("aosp_boot_absent", report["detailed_blocker_codes"])
        self.assertIn("no_launcher_trace", report["detailed_blocker_codes"])

    def test_survey_only_reports_are_not_collected_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "chip-os-gap-keyword-inventory.json",
                {
                    "status": "blocked",
                    "findings": [{"code": "todo_marker", "severity": "blocker"}],
                },
            )
            write_json(
                report_dir / "chip-os-objective-evidence-matrix.json",
                {
                    "status": "blocked",
                    "summary": {"blocked": 14},
                },
            )
            write_json(
                report_dir / "chip-os-closure-plan.json",
                {
                    "status": "blocked",
                    "summary": {"blocked_phases": 5},
                },
            )
            write_json(
                report_dir / "chip-os-environment-preflight.json",
                {
                    "status": "blocked",
                    "summary": {"findings": 12},
                },
            )
            write_json(
                report_dir / "chip-os-report-freshness.json",
                {
                    "status": "blocked",
                    "summary": {"stale_reports": 1},
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["detailed_blocker_entries"], 0)
        self.assertNotIn("todo_marker", report["detailed_blocker_codes"])
        self.assertNotIn("blocked_14", report["detailed_blocker_codes"])
        self.assertNotIn("blocked_phases_5", report["detailed_blocker_codes"])
        self.assertNotIn("findings_12", report["detailed_blocker_codes"])
        self.assertNotIn("stale_reports_1", report["detailed_blocker_codes"])

    def test_gate_report_aliases_cover_differently_named_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(
                aggregate,
                {
                    "gates": [
                        {
                            "name": "cpu-ap-completion-gate",
                            "status": "BLOCKED",
                            "subsystem": "cpu",
                            "tier": "rtl",
                            "evidence": "STATUS: BLOCKED cpu_ap.completion_gate",
                        },
                        {
                            "name": "minimum-linux-target-check",
                            "status": "BLOCKED",
                            "subsystem": "bsp",
                            "tier": "silicon",
                            "evidence": "STATUS: BLOCKED minimum_linux_kernel_target",
                        },
                        {
                            "name": "software-bsp-scaffold-check",
                            "status": "BLOCKED",
                            "subsystem": "bsp",
                            "tier": "spec",
                            "evidence": "STATUS: BLOCKED software_bsp.scaffold",
                        },
                    ]
                },
            )
            write_json(
                report_dir / "cpu_ap_scope.json",
                {"status": "cpu_ap_scope_release_blocked", "summary": {"missing": 4}},
            )
            write_json(
                report_dir / "minimum-linux-kernel-target.json",
                {"status": "blocked", "blockers": ["serial boot log missing"]},
            )
            write_json(
                report_dir / "software_bsp.json",
                {"status": "blocked", "findings": [{"code": "buildroot_log_missing"}]},
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, _ = inv.build_inventory(args)
        coverage = {row["name"]: row for row in report["aggregate_gate_detail_coverage"]}
        self.assertTrue(coverage["cpu-ap-completion-gate"]["has_detailed_report"])
        self.assertIn(
            str(report_dir / "cpu_ap_scope.json"),
            coverage["cpu-ap-completion-gate"]["matching_blocker_reports"],
        )
        self.assertTrue(coverage["minimum-linux-target-check"]["has_detailed_report"])
        self.assertTrue(coverage["software-bsp-scaffold-check"]["has_detailed_report"])
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)

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
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
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
