#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_optimization_gap_inventory.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_optimization_gap_inventory as opt


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], opt.CLAIM_BOUNDARY)
    for key, expected in opt.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ChipOsOptimizationGapInventoryTests(unittest.TestCase):
    def test_build_report_denies_runtime_performance_and_release_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo), mock.patch.object(opt, "ARTIFACTS", (spec,)):
                report = opt.build_report()

        self.assertEqual(report["status"], "pass")
        assert_false_claim_flags(self, report)

    def test_flags_nonpass_weak_scope_and_false_claim_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "blocked",
                        "claim_boundary": "modeled simulator evidence not phone runtime",
                        "release_claim_allowed": False,
                        "ready_for_sota_claim": False,
                        "runtime_coverage_ready": False,
                        "message": "blocked until target measurements exist",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)
        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_artifact_not_pass", codes)
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertIn("optimization_evidence_blocked_or_placeholder_text", codes)
        self.assertIn("optimization_required_boolean_false", codes)

    def test_clean_runtime_artifact_has_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "benchmark_success_allowed": True,
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)
        self.assertEqual(findings, [])

    def test_artifact_specific_pass_status_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/local-host-coremark-probe.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "local_host_evidence_not_release",
                        "claim_boundary": "host parser plumbing evidence",
                        "summary": {"passed_count": 1},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "local_coremark_probe",
                "cpu",
                "packages/chip/build/reports/local-host-coremark-probe.json",
                "local host CoreMark probe",
                "CPU baseline parser plumbing",
                pass_values=("local_host_evidence_not_release",),
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_artifact_not_pass",
            {finding["code"] for finding in findings},
        )

    def test_embedded_companion_reports_do_not_create_required_boolean_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "runtime_claim_allowed": True,
                        "companion_reports": {
                            "linux_probe": {
                                "report": {
                                    "summary": {
                                        "release_ready": False,
                                    }
                                }
                            }
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_required_boolean_false",
            {finding["code"] for finding in findings},
        )

    def test_embedded_companion_reports_do_not_create_blocked_text_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "companion_report": {
                            "status": "blocked",
                            "blockers": ["diagnostic sidecar remains blocked"],
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_evidence_blocked_or_placeholder_text",
            {finding["code"] for finding in findings},
        )

    def test_artifact_can_skip_blocked_text_but_keep_weak_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "minimum Linux only; not Android runtime evidence",
                        "stdout": "diagnostic sidecar remains BLOCKED",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "npu",
                "packages/chip/build/reports/demo.json",
                "demo NPU target",
                "Linux NPU smoke",
                scan_blocked_text=False,
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertNotIn("optimization_evidence_blocked_or_placeholder_text", codes)

    def test_mvp_npu_scale_sim_skips_modeled_capability_blocked_text(self) -> None:
        spec = next(artifact for artifact in opt.ARTIFACTS if artifact.ident == "mvp_npu_scale_sim")
        self.assertFalse(spec.scan_blocked_text)
        self.assertFalse(spec.must_pass)

    def test_artifact_skipping_blocked_text_keeps_nonpass_status_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "release_blocked",
                        "claim_boundary": "scope guard only; not runtime benchmark evidence",
                        "summary": "blocked until target measurements exist",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
                scan_blocked_text=False,
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        codes = {finding["code"] for finding in findings}
        self.assertIn("optimization_artifact_not_pass", codes)
        self.assertIn("optimization_evidence_weak_scope", codes)
        self.assertNotIn("optimization_evidence_blocked_or_placeholder_text", codes)

    def test_intentionally_false_claim_denials_are_not_runtime_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            artifact = repo / "packages/chip/build/reports/demo.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_text(
                json.dumps(
                    {
                        "status": "pass",
                        "claim_boundary": "chip emulator runtime benchmark evidence",
                        "phone_claim_allowed": False,
                        "release_claim_allowed": False,
                        "android_boot_claim_allowed": False,
                        "ready_for_runtime_claim": True,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            spec = opt.ArtifactSpec(
                "demo",
                "benchmarks",
                "packages/chip/build/reports/demo.json",
                "demo benchmark scope",
                "runtime optimization claim",
            )
            with mock.patch.object(opt, "REPO", repo):
                _, findings = opt.evaluate_artifact(spec)

        self.assertNotIn(
            "optimization_required_boolean_false",
            {finding["code"] for finding in findings},
        )

    def test_inventory_covers_android_no_issues_runtime_gates(self) -> None:
        artifact_ids = {artifact.ident for artifact in opt.ARTIFACTS}
        expected = {
            "android_launcher_runtime",
            "android_identity_contract",
            "android_app_runtime_contract",
            "android_system_apk_payload",
            "android_system_bridge",
            "aosp_hal_service_liveness",
            "android_evidence_capture_strictness",
            "android_release_readiness",
            "android_peripheral_evidence",
        }
        self.assertTrue(expected.issubset(artifact_ids))


if __name__ == "__main__":
    unittest.main()
