#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_optimization_gap_inventory.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_chip_os_optimization_gap_inventory as opt


class ChipOsOptimizationGapInventoryTests(unittest.TestCase):
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
