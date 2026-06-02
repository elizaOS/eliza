#!/usr/bin/env python3
"""Tests for scripts/check_npu_formal_coverage.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_npu_formal_coverage as gate


def valid_manifest() -> dict:
    return {
        "mode": "sby-shallow-top",
        "fallback_equivalent_to_sby": False,
        "strict_release_claim_allowed": False,
        "deep_top_required_for_release": True,
        "entries": {
            "e1_npu": {
                "status": "pass",
                "evidence_class": "sby_bmc",
                "paths": {
                    "status": "verify/formal/e1_npu/status",
                    "status_sha256": "a",
                    "log": "verify/formal/e1_npu/logfile.txt",
                    "log_sha256": "b",
                },
                "sby": {
                    "spec": "verify/formal/e1_npu.sby",
                    "engines": ["smtbmc bitwuzla"],
                    "covered_files": sorted(gate.EXPECTED["covered_files"]),
                    "tasks": {"default": {"mode": "bmc", "depth": "12"}},
                },
            }
        },
    }


class NpuFormalCoverageTests(unittest.TestCase):
    def test_valid_manifest_and_tokens_pass_with_false_claim_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            harness = tmp / "e1_npu_formal.sv"
            rtl = tmp / "e1_npu.sv"
            report = tmp / "npu_formal_coverage.json"
            manifest.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            harness.write_text("\n".join(gate.REQUIRED_HARNESS_TOKENS), encoding="utf-8")
            rtl.write_text("\n".join(gate.REQUIRED_RTL_TOKENS), encoding="utf-8")
            with (
                mock.patch.object(gate, "FORMAL_MANIFEST", manifest),
                mock.patch.object(gate, "HARNESS", harness),
                mock.patch.object(gate, "RTL", rtl),
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
            "production_accelerator_claim_allowed",
            "nnapi_claim_allowed",
            "performance_claim_allowed",
            "full_npu_correctness_claim_allowed",
            "driver_claim_allowed",
            "soc_fabric_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)
        self.assertEqual(payload.get("false_claim_flags"), gate.FALSE_CLAIM_FLAGS)

    def test_missing_formal_observability_token_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            harness = tmp / "e1_npu_formal.sv"
            rtl = tmp / "e1_npu.sv"
            report = tmp / "npu_formal_coverage.json"
            manifest.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            harness.write_text("\n".join(gate.REQUIRED_HARNESS_TOKENS), encoding="utf-8")
            rtl.write_text("formal_gemm_busy\n", encoding="utf-8")
            with (
                mock.patch.object(gate, "FORMAL_MANIFEST", manifest),
                mock.patch.object(gate, "HARNESS", harness),
                mock.patch.object(gate, "RTL", rtl),
                mock.patch.object(gate, "REPORT", report),
                mock.patch.object(gate, "ROOT", tmp),
            ):
                rc = gate.main()

            payload = json.loads(report.read_text(encoding="utf-8"))

        self.assertEqual(rc, 1)
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertTrue(any("NPU RTL missing formal token" in err for err in payload["errors"]))


if __name__ == "__main__":
    unittest.main()
