#!/usr/bin/env python3
"""Tests for scripts/check_axil_formal_coverage.py."""

from __future__ import annotations

import json
from copy import deepcopy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_axil_formal_coverage as gate


def target_entry(expected: dict) -> dict:
    return {
        "status": expected["status"],
        "evidence_class": expected["evidence_class"],
        "paths": {
            "status": f"{expected['spec']}.status",
            "status_sha256": "a",
            "log": f"{expected['spec']}.log",
            "log_sha256": "b",
        },
        "sby": {
            "spec": expected["spec"],
            "engines": ["smtbmc bitwuzla"],
            "covered_files": sorted(expected["covered_files"]),
            "tasks": deepcopy(expected["tasks"]),
        },
    }


def valid_manifest() -> dict:
    return {
        "mode": "sby-shallow-top",
        "fallback_equivalent_to_sby": False,
        "strict_release_claim_allowed": False,
        "deep_top_required_for_release": True,
        "entries": {
            name: target_entry(expected) for name, expected in gate.REQUIRED_TARGETS.items()
        },
    }


class AxilFormalCoverageTests(unittest.TestCase):
    def test_valid_manifest_passes_with_false_claim_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            report = tmp / "axil_formal_coverage.json"
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
            "full_soc_routing_claim_allowed",
            "unbounded_protocol_claim_allowed",
            "coherency_claim_allowed",
        ):
            self.assertIs(payload.get(key), False)

    def test_missing_interconnect_prove_task_blocks(self) -> None:
        manifest_payload = valid_manifest()
        del manifest_payload["entries"]["e1_axi_lite_interconnect"]["sby"]["tasks"]["prove"]
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            manifest = tmp / "formal_manifest.json"
            report = tmp / "axil_formal_coverage.json"
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
        self.assertIn("e1_axi_lite_interconnect missing task prove", payload["errors"])


if __name__ == "__main__":
    unittest.main()
