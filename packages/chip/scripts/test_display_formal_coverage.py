#!/usr/bin/env python3
"""Tests for scripts/check_display_formal_coverage.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_display_formal_coverage as gate


def valid_manifest() -> dict:
    return {
        "mode": "sby-shallow-top",
        "fallback_equivalent_to_sby": False,
        "strict_release_claim_allowed": False,
        "deep_top_required_for_release": True,
        "entries": {
            "e1_display_scanout": {
                "status": "pass",
                "evidence_class": "sby_bmc",
                "paths": {
                    "status": "verify/formal/e1_display_scanout/status",
                    "status_sha256": "a",
                    "log": "verify/formal/e1_display_scanout/logfile.txt",
                    "log_sha256": "b",
                },
                "sby": {
                    "spec": "verify/formal/e1_display_scanout.sby",
                    "engines": ["smtbmc z3"],
                    "covered_files": sorted(gate.EXPECTED["covered_files"]),
                    "tasks": {"bmc": {"mode": "bmc", "depth": "80", "multiclock": "off"}},
                },
            }
        },
    }


class DisplayFormalCoverageTests(unittest.TestCase):
    def test_valid_manifest_and_tokens_pass_with_false_claim_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            harness = tmp / "e1_display_scanout_formal.sv"
            rtl = tmp / "e1_display_scanout.sv"
            report = tmp / "display_formal_coverage.json"
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
            "panel_bringup_claim_allowed",
            "dsi_phy_claim_allowed",
            "drm_kms_claim_allowed",
            "full_display_correctness_claim_allowed",
            "production_framebuffer_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)

    def test_missing_underflow_assertion_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            harness = tmp / "e1_display_scanout_formal.sv"
            rtl = tmp / "e1_display_scanout.sv"
            report = tmp / "display_formal_coverage.json"
            manifest.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            harness.write_text("cover(saw_ar)\n", encoding="utf-8")
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

        self.assertEqual(rc, 1)
        self.assertEqual(payload["status"], "BLOCKED")
        self.assertTrue(
            any("display formal harness missing token" in err for err in payload["errors"])
        )


if __name__ == "__main__":
    unittest.main()
