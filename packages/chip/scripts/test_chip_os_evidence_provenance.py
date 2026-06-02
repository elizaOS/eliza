#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_evidence_provenance.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_evidence_provenance as provenance


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], provenance.CLAIM_BOUNDARY)
    for key, expected in provenance.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def assert_actionable_findings(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    findings = report.get("findings")
    testcase.assertIsInstance(findings, list)
    for finding in findings:
        testcase.assertIsInstance(finding, dict)
        testcase.assertIsInstance(finding.get("next_command"), str)
        testcase.assertTrue(finding["next_command"])
        testcase.assertIsInstance(finding.get("next_commands"), list)
        testcase.assertIn(finding["next_command"], finding["next_commands"])
    summary = report.get("summary")
    testcase.assertIsInstance(summary, dict)
    testcase.assertGreaterEqual(summary.get("next_command_batch_count", 0), 1)


class ChipOsEvidenceProvenanceTests(unittest.TestCase):
    def test_detects_host_path_reference_scope_and_missing_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "blocked",
                        "claim_boundary": "qemu_virt_reference_only_not_chip_boot",
                        "path": "/home/shaw/demo/artifact.log",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        assert_false_claim_flags(self, data)
        categories = data["summary"]["categories"]
        self.assertGreaterEqual(categories["host_local_path"], 1)
        self.assertGreaterEqual(categories["weak_reference_scope"], 1)
        self.assertGreaterEqual(categories["missing_timestamp"], 1)
        self.assertGreaterEqual(categories["nonpassing_status"], 1)
        assert_actionable_findings(self, data)
        host_rows = [
            row for row in data["findings"] if row["category"] == "host_local_path"
        ]
        self.assertIn("provenance_sanitize.py", host_rows[0]["next_command"])
        timestamp_rows = [
            row for row in data["findings"] if row["category"] == "missing_timestamp"
        ]
        self.assertIn("normalize_report_provenance.py", timestamp_rows[0]["next_command"])
        self.assertEqual(
            data["scan_root_summary"][0]["root"],
            "packages/chip/build/reports",
        )

    def test_passes_clean_timestamped_structured_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.v1",
                        "status": "pass",
                        "claim_boundary": "runtime evidence for selected chip emulator",
                        "generated_utc": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])
        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")
        assert_false_claim_flags(self, data)

    def test_android_peripheral_blocker_routes_to_capture_helper(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/android/peripherals/rear_camera_sim.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "generated_utc: 2026-05-21T00:00:00Z\n"
                "claim_boundary: android peripheral runtime evidence\n"
                "STATUS: BLOCKED no adb target\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        assert_actionable_findings(self, data)
        command = data["findings"][0]["next_command"]
        self.assertIn("capture_simulated_peripheral_evidence.py", command)

    def test_generated_at_utc_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu_ap/branch-prediction-params.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.bpu_params.v1",
                        "status": "clean",
                        "claim_boundary": "branch predictor parameter evidence only",
                        "generated_at_utc": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_generated_at_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu_ap/core-selection.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_core_selection_evidence.v1",
                        "status": "pass",
                        "claim_boundary": "core-selection inventory evidence only",
                        "generated_at": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_as_of_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/e1x_dft_cocotb.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.gate_status.v1",
                        "status": "PASS",
                        "claim_boundary": "DFT cocotb evidence only",
                        "as_of": "2026-05-21T00:00:00Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_sanitized_host_tmp_placeholder_is_not_host_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            sanitized = root / "docs/evidence/qemu-sanitized.log"
            raw = root / "docs/evidence/qemu-raw.log"
            sanitized.parent.mkdir(parents=True)
            sanitized.write_text(
                "## generated_utc: 2026-05-21T00:00:00Z\n"
                "## claim_boundary: sanitized host placeholder transcript\n"
                "virtiofs_mount=<host-tmp>/tmp.bnFbovaV2I\n",
                encoding="utf-8",
            )
            raw.write_text(
                "## generated_utc: 2026-05-21T00:00:00Z\n"
                "## claim_boundary: raw host transcript fixture\n"
                "virtiofs_mount=/tmp/raw-host-path\n",
                encoding="utf-8",
            )

            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        host_findings = [
            finding for finding in data["findings"] if finding["category"] == "host_local_path"
        ]
        self.assertEqual(len(host_findings), 1)
        self.assertEqual(host_findings[0]["path"], "packages/chip/docs/evidence/qemu-raw.log")

    def test_keyword_inventory_excerpts_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-os-gap-keyword-inventory.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.chip_os_gap_keyword_inventory.v1",
                        "status": "blocked",
                        "claim_boundary": "source keyword inventory only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "description": "stub/placeholder marker",
                                "excerpt": "TODO placeholder remains blocked",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_aggregate_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-os-bring-up-status.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.aggregate.v1",
                        "status": "blocked",
                        "claim_boundary": "aggregate survey only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "gates": [
                            {
                                "status": "BLOCKED",
                                "evidence": "placeholder transcript is missing",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_statusless_current_aggregate_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/chip-tapeout-readiness-current.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.tapeout_readiness.v1",
                        "claim_boundary": "aggregate survey only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "summary": {"blocked": 1},
                        "gates": [{"status": "BLOCKED", "evidence": "placeholder missing"}],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_mvp_simulator_pass_report_does_not_expand_nonpromoted_stage_blockers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/mvp_simulator.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.mvp_simulator.v1",
                        "status": "pass",
                        "claim_boundary": (
                            "Simulator MVP separates qemu-virt reference evidence from "
                            "OS running on generated Eliza AP/e1-chip RTL."
                        ),
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "on_chip_os_boot_claim": True,
                        "reference_qemu_virt_os_boot_claim": False,
                        "remaining_blockers": [
                            {
                                "name": "qemu_os_boot",
                                "detail": "STATUS: BLOCKED qemu OS boot missing rootfs",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_stub_audit_inventory_keeps_scope_but_not_allowlist_line_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/stub_audit.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.stub_audit.v1",
                        "status": "pass",
                        "claim_boundary": "stub_inventory_only_not_rtl_completion_or_os_boot_evidence",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "allowed_placeholder_inventory": [
                            "rtl/cpu/rvv/rvv_unit_stub.sv: explicitly blocked stub",
                            "rtl/top/e1_soc_integrated.sv: documented scaffold placeholder",
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "weak_reference_scope")

    def test_template_logs_keep_scope_without_marker_line_expansion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/linux/minimum_linux_kernel_smoke.template.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "STATUS: BLOCKED - template evidence; replace with captured transcript\n"
                "# claim_boundary: template_evidence_only_no_silicon_or_qemu_boot_claim\n"
                "# generated_utc: 2026-05-21T00:00:00Z\n"
                "# FORBIDDEN: placeholder\n"
                "# FORBIDDEN: status=FAIL\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_real_logs_still_expand_marker_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/linux/eliza_e1_serial_boot.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "STATUS: BLOCKED - placeholder transcript\n"
                "# claim_boundary: captured chip boot evidence\n"
                "# generated_utc: 2026-05-21T00:00:00Z\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        categories = data["summary"]["categories"]
        self.assertEqual(categories["blocked_marker"], 1)
        self.assertEqual(categories["placeholder_marker"], 1)

    def test_run_logs_skip_duplicate_markers_but_keep_host_path_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/phone-release-readiness-current.run.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "STATUS: BLOCKED phone-runtime-readiness-contract-check\n"
                "STATUS: FAIL duplicate aggregate transcript marker\n"
                "artifact copied from /home/shaw/aosp/out/target/product/eliza_ai_soc\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        categories = data["summary"]["categories"]
        self.assertNotIn("blocked_marker", categories)
        self.assertEqual(categories["host_local_path"], 1)

    def test_cpu_ap_manifest_uses_structured_completion_claim_not_line_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu-ap-evidence-manifest.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "generated_chipyard_artifacts_and_external_transcripts_only",
                        "completion_claim": "blocked_until_all_required_artifacts_and_evidence_pass",
                        "linux_capable_gate_matrix": [
                            {
                                "gate": "rv64gc_isa",
                                "status": "blocked",
                                "fail_if": ["placeholder transcript"],
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")
        self.assertEqual(
            data["findings"][0]["code"],
            "nonpassing_completion_claim_blocked_until_all_required_artifacts_and_evidence_pass",
        )

    def test_structured_active_blocker_inventory_does_not_expand_nested_status_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/cpu_ap_blocker_inventory.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_blocker_inventory.v1",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "inventory_only_no_evidence_created",
                        "active_blockers": [
                            {
                                "id": "chipyard_verilator_linux_smoke_timeout",
                                "status": "blocked",
                                "observed": ["required marker missing"],
                            },
                            {
                                "id": "cpu_ap_benchmark_runner_wiring",
                                "status": "blocked",
                                "observed": ["benchmark evidence missing"],
                            },
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["code"], "structured_active_blockers_present")
        self.assertEqual(data["findings"][0]["evidence"], "active_blockers=2")

    def test_minimum_linux_npu_target_diagnostic_blockers_do_not_expand_marker_lines(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/minimum_linux_npu_target.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.minimum_linux_npu_target.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "minimum Linux basic ML only; not Android NNAPI "
                            "or phone-class performance"
                        ),
                        "blocking_summary": {
                            "cpu_ap_transcript_bundle": {
                                "status": "passed",
                                "companion_report_statuses": {
                                    "ap_benchmarks": "blocked",
                                    "opensbi_boot": "blocked",
                                },
                            }
                        },
                        "benchmark_stdout": ("measured silicon power stays BLOCKED until lab run"),
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_runtime_capture_contract_keeps_scope_without_marker_line_expansion(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/android/runtime/live_runtime_capture_contracts.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.live_runtime_capture_contracts.v1",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "operator_capture_contracts_only_not_live_runtime_evidence"
                        ),
                        "live_capture_contracts": [
                            {
                                "fail_closed_validation_rule": (
                                    "BLOCKED unless status is PASS and no "
                                    "status=BLOCKED markers are present"
                                )
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "weak_reference_scope")

    def test_current_claim_disallowed_is_structured_not_line_expanded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu-ap-rva23-profile-plan.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_ap_rva23_profile_plan.v1",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "rva23_claim_blocked_until_profile_matrix_and_external_evidence_exist"
                        ),
                        "current_claim_allowed": False,
                        "required_profile_features_for_claim": [
                            {"id": "rva23.vector", "status": "blocked"}
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["code"], "structured_current_claim_disallowed")

    def test_mvp_npu_scale_scope_does_not_expand_unsupported_precision_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/mvp_npu_scale_sim.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.mvp_npu_scale_sim.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "Deterministic architecture scale model only; "
                            "not measured RTL, Android NNAPI, silicon performance, "
                            "or phone-class throughput evidence."
                        ),
                        "config": {
                            "precision_matrix": [
                                {
                                    "precision": "FP8",
                                    "state": "blocked",
                                    "claim": (
                                        "blocked until opcode/datapath/compiler "
                                        "and benchmark evidence exist"
                                    ),
                                }
                            ]
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "weak_reference_scope")

    def test_mvp_generated_ap_positive_claim_is_not_reference_only_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/mvp_simulator.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.mvp_simulator.v1",
                        "status": "pass",
                        "generated_utc": "2026-06-02T00:00:00Z",
                        "claim_boundary": (
                            "Simulator MVP separates qemu-virt reference evidence from "
                            "OS running on generated Eliza AP/e1-chip RTL. OS on our "
                            "chip may be claimed only when on_chip_os_boot_claim is true. "
                            "It is not a fabrication or phone-class performance claim."
                        ),
                        "on_chip_os_boot_claim": True,
                        "minimum_linux_npu_target_claim": True,
                        "integrated_linux_npu_ml_claim": True,
                        "best_executable_evidence": "chipyard_verilator_linux_smoke",
                        "best_executable_tier": "os_boot",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_mlperf_harness_keeps_scope_without_calibration_line_expansion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/benchmarks/mlperf-inference-harness-evidence.yaml"
            report.parent.mkdir(parents=True)
            report.write_text(
                "schema: eliza.benchmarks.mlperf_inference_harness_evidence.v1\n"
                "generated_utc: '2026-05-21T00:00:00Z'\n"
                "claim_boundary: modeled_preSilicon_not_official_submission_and_not_measured_power\n"
                "energy_joules_per_inference:\n"
                "  calibration: blocked-no-calibrated-assets\n"
                "  note: Reported with provenance simulator and a fail-closed calibration block.\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "weak_reference_scope")

    def test_nonpassing_structured_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/runtime_contract.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.runtime.v1",
                        "status": "blocked",
                        "claim_boundary": "runtime evidence contract",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "message": "placeholder transcript missing",
                                "evidence": "BLOCKED until runtime capture exists",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")

    def test_typed_blocked_structured_reports_do_not_expand_marker_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/software_bsp_scope.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.software_bsp_scope.v1",
                        "status": "software_bsp_scope_release_blocked",
                        "claim_boundary": "BSP scope audit only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "findings": [
                            {
                                "message": "vendor transcript missing required PASS markers",
                                "evidence": "status=FAIL placeholder remains blocked",
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")
        self.assertEqual(
            data["findings"][0]["code"],
            "nonpassing_status_software_bsp_scope_release_blocked",
        )

    def test_passing_structured_reports_still_scan_marker_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/runtime_contract.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.runtime.v1",
                        "status": "pass",
                        "claim_boundary": "runtime evidence contract",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "note": "placeholder transcript should not appear in passing evidence",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "placeholder_marker")

    def test_passing_structured_inventory_collapses_nested_nonpassing_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/software_bsp.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.software_bsp.v1",
                        "status": "pass",
                        "claim_boundary": "scaffold inventory only",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "scaffold_only": True,
                        "targets": [
                            {
                                "target": "aosp",
                                "scaffold_status": "PASS",
                                "evidence_status": "BLOCKED",
                                "blockers": [
                                    "external transcript has status=FAIL and placeholder text"
                                ],
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "nonpassing_status")
        self.assertEqual(
            data["findings"][0]["code"],
            "nested_nonpassing_status_targets_0_evidence_status_blocked",
        )

    def test_kernel_build_output_stub_and_dummy_paths_are_not_placeholders(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/linux/eliza_e1_kernel_build.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "eliza-evidence: started_utc=2026-05-21T00:00:00Z\n"
                "  CC      drivers/firmware/efi/libstub/efi-stub-helper.o\n"
                "  STUBCPY drivers/firmware/efi/libstub/riscv.stub.o\n"
                "  CC [M]  drivers/net/dummy.o\n"
                "  AR      drivers/iio/dummy/built-in.a\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_linux_runtime_terms_are_not_placeholder_or_blocked_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/linux/qemu_virt_boot.transcript.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "## generated_utc: 2026-05-21T00:00:00Z\n"
                "## claim_boundary: qemu boot transcript\n"
                "elizaOS Linux (live, fail-safe mode)\n"
                "EFI stub: Loaded initrd from LINUX_EFI_INITRD_MEDIA_GUID device path\n"
                "EFI stub: Generating empty DTB\n"
                "Console: colour dummy device 80x25\n"
                "Console: switching to colour dummy device 80x25\n"
                "serial port 0 not yet initialized\n"
                "dummy_hcd dummy_hcd.0: Dummy host controller\n"
                "dlkm_loader: Loaded kernel module /vendor/lib/modules/dummy-cpufreq.ko\n"
                "Fake: out/target/product/eliza_ai_soc/obj/FAKE/recovery_deps\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_fail_closed_posture_is_not_a_fail_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/display_scanout.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.display_scanout.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "Display scanout report documents fail-closed boundary behavior "
                            "without claiming phone runtime evidence."
                        ),
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_status_blocked_fail_closed_line_still_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/android/blocked-runtime.log"
            report.parent.mkdir(parents=True)
            report.write_text(
                "STATUS: BLOCKED runtime remains fail-closed until target capture\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["categories"]["blocked_marker"], 1)

    def test_generated_report_references_to_stub_named_reports_are_not_placeholders(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/manufacturing-resolved-artifacts.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.generated_inventory.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "generated inventory only",
                        "source_reports": [
                            "board/kicad/e1-phone/kicad-cad-end-to-end-stub-audit-2026-05-22.yaml",
                            "pd/n2p-stub/access-gate.yaml",
                        ],
                        "purpose": "aggregate gate detail report for stub-audit",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_technical_stub_and_sentinel_terms_are_not_placeholder_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/technical_terms.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.technical_terms.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": (
                            "CPU subsystem is the CVA6-disabled stub unless E1_HAVE_CVA6. "
                            "The dispatch-boundary stub for unsupported ops "
                            "(rtl/cpu/rvv/rvv_unit_stub.sv) remains out of RVV scope. "
                            "The current Sky130 e1 release contains the chip-top stub only."
                        ),
                        "checks": [
                            {
                                "status": "pass",
                                "detail": (
                                    "model-shard sample payload has 9281 contiguous shard "
                                    "words plus one sentinel and checksum 3823329054"
                                ),
                            }
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)

    def test_generic_stub_and_placeholder_terms_remain_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/generic_placeholder.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "demo.generic_placeholder.v1",
                        "status": "pass",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "generic placeholder transcript",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["category"], "placeholder_marker")

    def test_structured_claim_boundary_is_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/demo.yaml"
            report.parent.mkdir(parents=True)
            report.write_text(
                "schema: demo.v1\n"
                "status: pass\n"
                "generated_utc: '2026-05-21T00:00:00Z'\n"
                "claim_boundary:\n"
                "  allowed_current_claims:\n"
                "    - scaffold only\n"
                "  blocked_claims:\n"
                "    - release evidence\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_draft_structured_status_suppresses_nested_marker_expansion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/power/droop-sensor-evidence.yaml"
            report.parent.mkdir(parents=True)
            report.write_text(
                "schema: eliza.droop_sensor_evidence.v1\n"
                "status: planning_draft\n"
                "generated_utc: '2026-05-21T00:00:00Z'\n"
                "claim_boundary: droop sensor contract evidence inventory\n"
                "release_blockers:\n"
                "  - threshold values are placeholder.\n"
                "required_evidence:\n"
                "  - id: silicon_characterization\n"
                "    status: blocked\n"
                "    blockers:\n"
                "      - threshold_i values are placeholder\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 1)
        self.assertEqual(data["findings"][0]["code"], "nonpassing_status_planning_draft")

    def test_result_recorded_at_counts_as_timestamp_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/cpu_ap/cva6-coremark-verilator.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.cpu_benchmark_measured.v1",
                        "status": "passed",
                        "claim_boundary": "CoreMark RTL simulator benchmark evidence only.",
                        "result_recorded_at": "2026-05-29T08:49:50Z",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_software_bsp_manifest_forbidden_strings_are_not_line_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "docs/evidence/software-bsp-evidence-manifest.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "external transcript validation manifest only",
                        "targets": {
                            "aosp": {
                                "evidence": [
                                    {
                                        "artifact": "SELinux policy build transcript",
                                        "forbidden_strings": ["FAILED:", "placeholder"],
                                        "required_strings": ["eliza-evidence: status=PASS"],
                                    }
                                ]
                            }
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/docs/evidence"])

        self.assertEqual(data["summary"]["findings"], 0)
        self.assertEqual(data["status"], "pass")

    def test_default_roots_cover_os_android_release_and_app_payload_manifests(self) -> None:
        expected = {
            "packages/chip/build/reports",
            "packages/chip/docs/evidence",
            "packages/os/linux/elizaos/evidence",
            "packages/os/android/installer/manifests",
            "packages/os/android/vendor/eliza/manifests",
            "packages/os/release/beta-2026-05-16",
            "packages/os/release/confidential-2026-05-21",
            "packages/app/android/app/src/main/assets/agent/plugins-manifest.json",
        }
        self.assertTrue(expected.issubset(set(provenance.DEFAULT_SCAN_ROOTS)))

    def test_status_test_reports_are_not_live_evidence_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            root = repo / "packages/chip"
            report = root / "build/reports/mvp_simulator.status-test.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.mvp_simulator.v1",
                        "status": "blocked",
                        "generated_utc": "2026-05-21T00:00:00Z",
                        "claim_boundary": "negative unit test fixture only",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(provenance, "REPO", repo),
                mock.patch.object(provenance, "ROOT", root),
            ):
                data = provenance.build_report(["packages/chip/build/reports"])

        self.assertEqual(data["summary"]["files_scanned"], 0)
        self.assertEqual(data["summary"]["findings"], 0)


if __name__ == "__main__":
    unittest.main()
