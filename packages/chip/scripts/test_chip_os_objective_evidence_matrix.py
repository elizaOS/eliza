#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_objective_evidence_matrix.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import check_chip_os_objective_evidence_matrix as matrix


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


class ChipOsObjectiveEvidenceMatrixTests(unittest.TestCase):
    def test_missing_reports_block_every_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = matrix.build_matrix(Path(tmp))
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["missing"], len(matrix.REQUIREMENTS))

    def test_pass_reports_prove_runtime_and_keep_static_contract_weak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp)
            for req in matrix.REQUIREMENTS:
                data: dict[str, object] = {"status": req.required_status, "findings": []}
                for field, expected in req.required_fields:
                    if "." in field:
                        first, second = field.split(".", 1)
                        data.setdefault(first, {})
                        assert isinstance(data[first], dict)
                        data[first][second] = expected
                    else:
                        data[field] = expected
                write_json(report_dir / req.required_report, data)
            report = matrix.build_matrix(report_dir)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["proven"], len(matrix.REQUIREMENTS) - 1)
        self.assertEqual(report["summary"]["weak_static_only"], 1)
        weak = [
            row
            for row in report["requirements"]
            if row["proof_state"] == matrix.WEAK
        ]
        self.assertEqual([row["id"] for row in weak], ["cross_fork_agent_payload_static_contract"])

    def test_field_expectations_block_when_status_pass_is_too_weak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp)
            req = next(
                item
                for item in matrix.REQUIREMENTS
                if item.ident == "aosp_full_virtual_device_boot"
            )
            write_json(report_dir / req.required_report, {"status": "pass", "require_full_evidence": False})
            row = matrix.evaluate_requirement(req, report_dir)
        self.assertEqual(row["proof_state"], matrix.BLOCKED)
        self.assertIn("require_full_evidence", row["findings"][0])


if __name__ == "__main__":
    unittest.main()
