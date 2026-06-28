#!/usr/bin/env python3
"""Regression tests for the SoC real-integration gate report boundary."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_soc_real_integration as gate


class SocRealIntegrationReportTests(unittest.TestCase):
    def test_report_denies_cpu_linux_release_claims(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            report = Path(tmpdir) / "soc_integration.json"
            with (
                mock.patch.object(gate, "REPORT", report),
                mock.patch.object(gate, "_verilator", return_value="/bin/true"),
                mock.patch.object(
                    gate,
                    "check_lint",
                    return_value={
                        "id": "verilator_elaborate_integrated",
                        "status": "pass",
                        "detail": "lint clean",
                    },
                ),
                mock.patch.object(
                    gate,
                    "run_cocotb",
                    return_value={
                        "id": gate.SMOKE["id"],
                        "status": "pass",
                        "detail": "smoke clean",
                    },
                ),
            ):
                rc = gate.main()

            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(payload["status"], "PASS")
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "linux_boot_claim_allowed",
            "production_cpu_claim_allowed",
            "real_cpu_execution_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)
        boundary = payload["claim_boundary"]
        self.assertIn("does NOT prove: real CPU execution", boundary)
        self.assertIn("OpenSBI/Linux boot", boundary)


if __name__ == "__main__":
    unittest.main()
