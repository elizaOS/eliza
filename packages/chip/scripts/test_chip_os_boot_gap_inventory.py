#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_boot_gap_inventory.py."""

from __future__ import annotations

import json
import os
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
            report_dir.mkdir()
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
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)
        self.assertIn("missing_chip_boot_evidence", report["detailed_blocker_codes"])
        covered = {
            row["name"]: row["has_structured_blocker"]
            for row in report["aggregate_gate_detail_coverage"]
        }
        self.assertTrue(covered["linux-boot"])
        self.assertTrue(covered["os-release"])
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
            report_dir.mkdir()
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
            os.utime(aggregate, (200, 200))
            os.utime(report_dir / "linux_bsp_contract.json", (100, 100))
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, _ = inv.build_inventory(args)
        coverage = report["aggregate_gate_detail_coverage"][0]
        self.assertFalse(coverage["has_detailed_report"])
        self.assertFalse(coverage["has_structured_blocker"])
        self.assertEqual(
            coverage["mismatched_detail_reports"], [str(report_dir / "linux_bsp_contract.json")]
        )
        self.assertIn(
            "detail_report_mismatch_linux_bsp_contract_check",
            report["detailed_blocker_codes"],
        )
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 1)

    def test_newer_pass_report_marks_nonpass_aggregate_gate_stale(self) -> None:
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
                {"status": "pass", "findings": []},
            )
            os.utime(aggregate, (100, 100))
            os.utime(report_dir / "android_app_runtime_contract.json", (200, 200))
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, _ = inv.build_inventory(args)
        coverage = report["aggregate_gate_detail_coverage"][0]
        self.assertTrue(coverage["has_detailed_report"])
        self.assertTrue(coverage["has_structured_blocker"])
        self.assertEqual(
            coverage["matching_current_pass_reports"],
            [str(report_dir / "android_app_runtime_contract.json")],
        )
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)
        self.assertIn(
            "stale_aggregate_gate_android_app_runtime_contract_check",
            report["detailed_blocker_codes"],
        )

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
        self.assertEqual(report["summary"]["detailed_blocker_entries"], 3)
        self.assertEqual(report["summary"]["nonpassing_reports_without_structured_details"], 1)
        self.assertIn("aosp_boot_absent", report["detailed_blocker_codes"])
        self.assertIn("no_launcher_trace", report["detailed_blocker_codes"])
        self.assertIn("unstructured_nonpass_report_b", report["detailed_blocker_codes"])

    def test_nonpass_report_without_structured_rows_is_quality_gap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "android_sim_boot.json",
                {
                    "status": "blocked",
                    "summary": {"attempted": 0},
                    "reason": "AOSP_DIR unset",
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["nonpassing_reports_without_structured_details"], 1)
        self.assertEqual(
            report["nonpassing_reports_without_structured_details"][0]["source_report"],
            str(report_dir / "android_sim_boot.json"),
        )
        self.assertIn(
            "unstructured_nonpass_report_android_sim_boot",
            report["detailed_blocker_codes"],
        )

    def test_legacy_gate_status_report_is_structured_closure_row(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "gate-board_fabrication_release.json",
                {
                    "schema": "eliza.gate_status.v1",
                    "gate": "board_fabrication_release",
                    "status": "FAIL",
                    "blocker_id": None,
                    "blocker_reason": None,
                    "evidence_paths": ["pd/signoff/manifest.yaml"],
                    "subsystem": "pd",
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["nonpassing_reports_without_structured_details"], 0)
        self.assertIn(
            "gate_status_board_fabrication_release_fail",
            report["detailed_blocker_codes"],
        )

    def test_structured_blockers_and_failures_become_stable_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "mvp_simulator.json",
                {
                    "status": "fail",
                    "failures": [
                        {
                            "name": "cpu_ap_linux_evidence",
                            "detail": "STATUS: FAIL cpu_ap.linux_evidence",
                            "next_command": "python3 scripts/check_cpu_ap_evidence.py --require-evidence",
                        }
                    ],
                    "blockers_to_on_chip_os_boot": [
                        {
                            "name": "chipyard_payload_path",
                            "detail": "STATUS: BLOCKED chipyard.payload_path",
                            "next_command": "python3 scripts/check_chipyard_payload_path.py",
                        }
                    ],
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertIn("failure_cpu_ap_linux_evidence", report["detailed_blocker_codes"])
        self.assertIn(
            "blockers_to_on_chip_os_boot_chipyard_payload_path",
            report["detailed_blocker_codes"],
        )

    def test_entries_array_counts_as_structured_blocker_detail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            write_json(aggregate, {"gates": []})
            write_json(
                report_dir / "cpu_phone_l5_l6_benchmark_report.json",
                {
                    "status": "blocked",
                    "entries": [
                        {
                            "name": "spec_cpu2017",
                            "reason": "SPEC_DIR not set",
                            "unblock": {"next_command": "SPEC_DIR=<licensed> make spec"},
                        }
                    ],
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, exit_code = inv.build_inventory(args)
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["summary"]["nonpassing_reports_without_structured_details"], 0)
        self.assertIn("entry_spec_cpu2017", report["detailed_blocker_codes"])

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
                report_dir / "chip-os-evidence-provenance.json",
                {
                    "status": "blocked",
                    "findings": [{"code": "host_local_path", "severity": "blocker"}],
                },
            )
            write_json(
                report_dir / "chip-os-optimization-gap-inventory.json",
                {
                    "status": "blocked",
                    "findings": [{"code": "optimization_artifact_not_pass", "severity": "blocker"}],
                },
            )
            write_json(
                report_dir / "chip-os-identity-contract.json",
                {
                    "status": "blocked",
                    "findings": [
                        {"code": "android_package_identity_mismatch", "severity": "blocker"}
                    ],
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
        self.assertNotIn("host_local_path", report["detailed_blocker_codes"])
        self.assertNotIn("optimization_artifact_not_pass", report["detailed_blocker_codes"])
        self.assertNotIn("android_package_identity_mismatch", report["detailed_blocker_codes"])
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

    def test_aggregate_only_nonpass_gate_gets_structured_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aggregate = root / "aggregate.json"
            report_dir = root / "reports"
            report_dir.mkdir()
            write_json(
                aggregate,
                {
                    "gates": [
                        {
                            "name": "os-rv64-release-check",
                            "status": "FAIL",
                            "subsystem": "os_rv64",
                            "tier": "spec",
                            "evidence": "STATUS: FAIL release-manifest gate",
                        }
                    ]
                },
            )
            args = inv.parse_args(["--aggregate", str(aggregate), "--report-dir", str(report_dir)])
            report, _ = inv.build_inventory(args)
        coverage = report["aggregate_gate_detail_coverage"][0]
        self.assertFalse(coverage["has_detailed_report"])
        self.assertTrue(coverage["has_structured_blocker"])
        self.assertEqual(
            coverage["matching_aggregate_blockers"],
            ["aggregate_fail_os_rv64_release_check"],
        )
        self.assertEqual(report["summary"]["uncovered_nonpassing_gates"], 0)
        self.assertIn("aggregate_fail_os_rv64_release_check", report["detailed_blocker_codes"])

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
