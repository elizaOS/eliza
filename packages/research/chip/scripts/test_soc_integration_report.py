#!/usr/bin/env python3
"""Tests for the soc-integration claim-boundary report."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_soc_integration as gate
import check_soc_real_integration as real_gate


class SocIntegrationReportTests(unittest.TestCase):
    def test_pass_report_denies_production_routing_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            report = Path(tmpdir) / "soc_cross_domain_integration.json"
            with mock.patch.object(gate, "REPORT", report):
                gate.write_report("PASS", None, None)
            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(payload["status"], "PASS")
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "production_fabric_claim_allowed",
            "full_soc_routing_claim_allowed",
            "coherency_claim_allowed",
            "iommu_claim_allowed",
            "qos_claim_allowed",
            "linux_boot_claim_allowed",
            "production_cpu_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)
        self.assertEqual(payload.get("false_claim_flags"), gate.FALSE_CLAIM_FLAGS)
        boundary = payload["claim_boundary"]
        for token in ("not production SoC routing", "coherency", "IOMMU", "QoS", "Linux boot"):
            self.assertIn(token, boundary)

    def test_main_writes_fail_closed_report_on_blocked_lint(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            report = Path(tmpdir) / "soc_cross_domain_integration.json"
            with (
                mock.patch.object(gate, "REPORT", report),
                mock.patch.object(gate, "verilator_lint", return_value=2),
            ):
                rc = gate.main()
            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 2)
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertEqual(payload["blocker_id"], "soc_integration_lint_blocked")
        self.assertIs(payload["production_fabric_claim_allowed"], False)
        self.assertEqual(payload.get("false_claim_flags"), gate.FALSE_CLAIM_FLAGS)

    def test_real_soc_report_denies_cpu_and_boot_claims(self) -> None:
        checks = [
            {"id": "lint", "status": "pass", "detail": "ok"},
            {"id": "smoke", "status": "pass", "detail": "ok"},
        ]
        report = {
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "linux_boot_claim_allowed": False,
            "production_cpu_claim_allowed": False,
            "real_cpu_execution_claim_allowed": False,
            "false_claim_flags": real_gate.FALSE_CLAIM_FLAGS,
            "summary": {
                "check_count": len(checks),
                "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            },
        }
        for key, value in real_gate.FALSE_CLAIM_FLAGS.items():
            self.assertIs(report.get(key), value)
        self.assertEqual(report["false_claim_flags"], real_gate.FALSE_CLAIM_FLAGS)


if __name__ == "__main__":
    unittest.main()
