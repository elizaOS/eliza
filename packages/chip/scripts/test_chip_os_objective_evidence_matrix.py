#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_objective_evidence_matrix.py."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import check_chip_os_objective_evidence_matrix as matrix


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], matrix.CLAIM_BOUNDARY)
    for key, expected in matrix.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


class ChipOsObjectiveEvidenceMatrixTests(unittest.TestCase):
    def test_missing_reports_block_every_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = matrix.build_matrix(Path(tmp))
        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        self.assertEqual(report["summary"]["missing"], len(matrix.REQUIREMENTS))

    def test_pass_reports_prove_runtime_and_keep_static_contract_weak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp)
            for req in matrix.REQUIREMENTS:
                data: dict[str, object] = {"status": req.required_status, "findings": []}
                for field, expected in req.required_fields:
                    if "." in field:
                        first, second = field.split(".", 1)
                        nested = data.setdefault(first, {})
                        assert isinstance(nested, dict)
                        nested[second] = expected
                    else:
                        data[field] = expected
                write_json(report_dir / req.required_report, data)
            report = matrix.build_matrix(report_dir)
        self.assertEqual(report["status"], "blocked")
        assert_false_claim_flags(self, report)
        expected_weak = sum(1 for req in matrix.REQUIREMENTS if req.static_only)
        self.assertEqual(report["summary"]["proven"], len(matrix.REQUIREMENTS) - expected_weak)
        self.assertEqual(report["summary"]["weak_static_only"], expected_weak)
        weak = [row for row in report["requirements"] if row["proof_state"] == matrix.WEAK]
        self.assertEqual(
            [row["id"] for row in weak],
            [req.ident for req in matrix.REQUIREMENTS if req.static_only],
        )

    def test_field_expectations_block_when_status_pass_is_too_weak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp)
            req = next(
                item
                for item in matrix.REQUIREMENTS
                if item.ident == "aosp_full_virtual_device_boot"
            )
            write_json(
                report_dir / req.required_report, {"status": "pass", "require_full_evidence": False}
            )
            row = matrix.evaluate_requirement(req, report_dir)
        self.assertEqual(row["proof_state"], matrix.BLOCKED)
        self.assertIn("require_full_evidence", row["findings"][0])

    def test_report_findings_include_entries_arrays(self) -> None:
        codes = matrix.report_findings(
            {
                "entries": [
                    {
                        "name": "spec_cpu2017",
                        "reason": "SPEC_DIR not set",
                    }
                ]
            }
        )
        self.assertIn("entry_spec_cpu2017", codes)

    def test_json_only_prints_report_without_status_line(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report_dir = Path(tmp) / "reports"
            report_dir.mkdir()
            for req in matrix.REQUIREMENTS:
                data = {
                    "schema": "demo.v1",
                    "status": req.required_status,
                    "claim_boundary": "test evidence",
                }
                for field, expected in req.required_fields:
                    current = data
                    parts = field.split(".")
                    for part in parts[:-1]:
                        current = current.setdefault(part, {})
                    current[parts[-1]] = expected
                (report_dir / req.required_report).write_text(
                    json.dumps(data) + "\n", encoding="utf-8"
                )
            output = Path(tmp) / "matrix.json"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = matrix.main(
                    ["--report-dir", str(report_dir), "--report", str(output), "--json-only"]
                )
            written = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertNotIn("STATUS:", stdout.getvalue())
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["schema"], matrix.SCHEMA)
        self.assertEqual(written, data)


if __name__ == "__main__":
    unittest.main()
