#!/usr/bin/env python3
"""Regression tests for prototype status dashboard validation."""

from __future__ import annotations

import unittest

import check_prototype_status_dashboard as dashboard
from check_prototype_status_dashboard import conservative_snapshot_allowed


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], dashboard.CLAIM_BOUNDARY)
    for key, expected in dashboard.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class PrototypeStatusDashboardTest(unittest.TestCase):
    def test_report_payload_denies_boot_runtime_and_release_claims(self) -> None:
        report = dashboard.report_payload(
            "fail",
            [
                dashboard.blocker(
                    "missing",
                    "missing dashboard row",
                    "docs/project/prototype-status-dashboard.md",
                    "restore the dashboard",
                )
            ],
        )
        self.assertEqual(report["status"], "fail")
        self.assertEqual(report["summary"]["findings"], 1)
        assert_false_claim_flags(self, report)

    def test_allows_conservative_generated_artifact_rows(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`regen_required`",
            "Next action": "`make cocotb`",
        }
        self.assertTrue(conservative_snapshot_allowed("cocotb", status, row))

    def test_does_not_mask_nonvolatile_stale_rows(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`regen_required`",
            "Next action": "`make qemu-check`",
        }
        self.assertFalse(conservative_snapshot_allowed("product-package", status, row))

    def test_allows_qemu_reference_smoke_to_remain_conservative(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make qemu-check`",
        }
        self.assertTrue(conservative_snapshot_allowed("qemu", status, row))

    def test_allows_formal_fallback_to_remain_conservative(self) -> None:
        status = {
            "status": "block",
            "evidence_class": "formal_fallback",
            "next_step": "make formal-strict",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make formal inside Docker/Nix`",
        }
        self.assertTrue(conservative_snapshot_allowed("formal", status, row))

    def test_allows_tool_available_regen_drift(self) -> None:
        status = {
            "status": "block",
            "evidence_class": "regen_required",
            "next_step": "make synth",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make synth`",
        }
        self.assertTrue(conservative_snapshot_allowed("synthesis", status, row))

    def test_allows_benchmark_regen_to_remain_scaffold_only(self) -> None:
        status = {
            "status": "block",
            "evidence_class": "regen_required",
            "next_step": "make benchmarks-dry-run",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`scaffold_only`",
            "Next action": "`python3 benchmarks/run_benchmarks.py run --metadata benchmarks/metadata/strict-blocked-template.json --strict-missing`",
        }
        self.assertTrue(conservative_snapshot_allowed("benchmarks", status, row))

    def test_allows_npu_ml_proof_to_remain_source_only_conservative(self) -> None:
        status = {
            "status": "pass",
            "evidence_class": "generated_artifact",
            "next_step": "none",
        }
        row = {
            "Status": "`BLOCK`",
            "Evidence class": "`tool_blocker`",
            "Next action": "`make mvp-npu-ml-evidence-check`",
        }
        self.assertTrue(conservative_snapshot_allowed("npu-ml-proof", status, row))


if __name__ == "__main__":
    unittest.main()
