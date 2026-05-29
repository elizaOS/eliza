#!/usr/bin/env python3
"""Tests for scripts/check_dma_formal_coverage.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_dma_formal_coverage as gate


def valid_manifest() -> dict:
    return {
        "mode": "sby-shallow-top",
        "fallback_equivalent_to_sby": False,
        "strict_release_claim_allowed": False,
        "deep_top_required_for_release": True,
        "entries": {
            "e1_dma": {
                "status": "pass",
                "evidence_class": "sby_bmc",
                "paths": {
                    "status": "verify/formal/e1_dma/status",
                    "status_sha256": "a",
                    "log": "verify/formal/e1_dma/logfile.txt",
                    "log_sha256": "b",
                },
                "sby": {
                    "spec": "verify/formal/e1_dma.sby",
                    "engines": ["smtbmc bitwuzla"],
                    "covered_files": [
                        "rtl/dma/e1_dma.sv",
                        "verify/formal/e1_dma_formal.sv",
                    ],
                    "tasks": {"default": {"mode": "bmc", "depth": "12"}},
                },
            },
            "e1_dma_axil": {
                "status": "pass",
                "evidence_class": "sby_bmc",
                "paths": {
                    "status": "verify/formal/e1_dma_axil/status",
                    "status_sha256": "c",
                    "log": "verify/formal/e1_dma_axil/logfile.txt",
                    "log_sha256": "d",
                },
                "sby": {
                    "spec": "verify/formal/e1_dma_axil.sby",
                    "engines": ["smtbmc bitwuzla"],
                    "covered_files": [
                        "verify/properties/axi_lite_protocol.sv",
                        "rtl/dma/e1_dma.sv",
                        "verify/properties/dma_axil_bind.sv",
                    ],
                    "tasks": {
                        "bmc": {"mode": "bmc", "depth": "32"},
                        "prove": {"mode": "prove", "depth": "16"},
                    },
                },
            },
        },
    }


class DmaFormalCoverageTests(unittest.TestCase):
    def test_valid_manifest_passes_with_false_claim_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            report = tmp / "dma_formal_coverage.json"
            manifest.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            with (
                mock.patch.object(gate, "FORMAL_MANIFEST", manifest),
                mock.patch.object(gate, "REPORT", report),
                mock.patch.object(gate, "ROOT", tmp),
            ):
                rc = gate.main()

            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(payload["status"], "PASS")
        for key in (
            "phone_claim_allowed",
            "release_claim_allowed",
            "full_dma_correctness_claim_allowed",
            "coherent_dma_claim_allowed",
            "linux_dmaengine_driver_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)

    def test_missing_axi_lite_prove_task_blocks(self) -> None:
        manifest_payload = valid_manifest()
        del manifest_payload["entries"]["e1_dma_axil"]["sby"]["tasks"]["prove"]
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            report = tmp / "dma_formal_coverage.json"
            manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
            with (
                mock.patch.object(gate, "FORMAL_MANIFEST", manifest),
                mock.patch.object(gate, "REPORT", report),
                mock.patch.object(gate, "ROOT", tmp),
            ):
                rc = gate.main()

            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 1)
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertIn("e1_dma_axil missing task prove", payload["errors"])


if __name__ == "__main__":
    unittest.main()
