#!/usr/bin/env python3
"""Tests for scripts/check_core_selection.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_core_selection as gate


class CoreSelectionTests(unittest.TestCase):
    def test_build_report_has_scope_and_timestamp_metadata(self) -> None:
        grouped: dict[str, list[tuple[str, dict, bool]]] = {
            "big": [("big.json", {"core_role": "big_core_e1_ultra", "status": "selected"}, True)],
            "mid": [],
            "mid_fallback": [
                ("mid.json", {"core_role": "mid_core_fallback", "status": "selected"}, True)
            ],
            "little": [
                ("little.json", {"core_role": "little_core_e1_pro", "status": "selected"}, True)
            ],
            "linux_bringup": [
                (
                    "rocket.json",
                    {"core_role": "linux_bringup_application_hart", "status": "selected"},
                    True,
                )
            ],
            "unknown": [],
        }

        report = gate.build_report(grouped, [], require_big_core_pin=False)

        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
        self.assertRegex(str(report["generated_utc"]), r"^\d{4}-\d{2}-\d{2}T")

    def test_write_evidence_has_scope_and_timestamp_metadata(self) -> None:
        grouped: dict[str, list[tuple[str, dict, bool]]] = {
            "big": [],
            "mid": [],
            "mid_fallback": [],
            "little": [],
            "linux_bringup": [],
            "unknown": [],
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "chip"
            manifest_dir = root / "generators/chipyard"
            evidence_dir = root / "docs/evidence/cpu_ap"
            evidence_path = evidence_dir / "core-selection.json"
            manifest_dir.mkdir(parents=True)

            with (
                mock.patch.object(gate, "ROOT", root),
                mock.patch.object(gate, "MANIFEST_DIR", manifest_dir),
                mock.patch.object(gate, "EVIDENCE_DIR", evidence_dir),
                mock.patch.object(gate, "EVIDENCE_PATH", evidence_path),
            ):
                gate.write_evidence(grouped, [])

            payload = json.loads(evidence_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["claim_boundary"], gate.CLAIM_BOUNDARY)
        self.assertRegex(payload["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(payload["generated_at"], payload["generated_utc"])


if __name__ == "__main__":
    unittest.main()
