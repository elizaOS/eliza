#!/usr/bin/env python3
"""Tests for e1_phone_first_article_executed_log_contract.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import e1_phone_first_article_executed_log_contract as gate  # noqa: E402


def write_yaml(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return path


class E1PhoneFirstArticleExecutedLogContractTests(unittest.TestCase):
    def test_missing_highest_leverage_logs_are_guidance_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            matrix = write_yaml(
                tmp / "matrix.yaml",
                {
                    "schema": gate.EXPECTED_MATRIX_SCHEMA,
                    "acceptance_matrix": [
                        {
                            "path": "board/kicad/e1-phone/production/reports/usb-c-pd-attach-log.json",
                            "evidence_kind": "executed_log",
                        }
                    ],
                },
            )
            diagnostic = write_yaml(
                tmp / "diagnostic.yaml",
                {
                    "recommended_next_evidence_packets": [
                        {
                            "id": "executed_first_article_bench_logs",
                            "release_credit": False,
                            "missing_paths": [
                                "board/kicad/e1-phone/production/reports/usb-c-pd-attach-log.json"
                            ],
                        }
                    ]
                },
            )
            with mock.patch.object(gate, "CHIP_ROOT", tmp):
                report = gate.build_report(matrix, diagnostic, tmp / "report.yaml")

        self.assertEqual(report["schema"], gate.REPORT_SCHEMA)
        self.assertFalse(report["summary"]["release_credit"])
        self.assertEqual(report["summary"]["missing_log_count"], 1)
        row = report["executed_log_contract_rows"][0]
        self.assertFalse(row["release_credit"])
        self.assertFalse(row["contract_valid"])
        self.assertEqual(row["validation_failures"], ["artifact_missing"])

    def test_valid_future_log_passes_contract_without_release_credit(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            log_rel = "board/kicad/e1-phone/production/reports/usb-c-pd-attach-log.json"
            log_path = tmp / log_rel
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(
                json.dumps(
                    {
                        "schema": gate.EXPECTED_LOG_SCHEMA,
                        "artifact_id": "fa-usbc-pd-evt1-001",
                        "source_requirement_id": "usb_c_pd_attach",
                        "evidence_role": "executed_first_article_bench_log",
                        "release_credit": False,
                        "board_serial": "E1-EVT1-0001",
                        "board_revision": "EVT1",
                        "board_configuration": "routed-mainboard",
                        "supplier_lot_ids": ["pcba-lot-a", "usb-c-lot-b"],
                        "fixture_id": "fixture-usbc-001",
                        "fixture_calibration_id": "cal-2026-05-22",
                        "test_software_revision": "e1-phone-fa-usbc@abc123",
                        "operator": "lab-operator",
                        "started_at": "2026-05-22T10:00:00Z",
                        "completed_at": "2026-05-22T10:05:00Z",
                        "limits_file": "board/kicad/e1-phone/production/test/factory-test-limits.yaml",
                        "measured_results": [
                            {
                                "measurement_id": "src_attach_voltage",
                                "metric": "vbus_attach_voltage",
                                "value": 5.08,
                                "unit": "V",
                                "limit": {"min": 4.75, "max": 5.25},
                                "result": "pass",
                            }
                        ],
                        "pass_fail_disposition": "pass",
                        "waivers": [],
                        "reviewer": "manufacturing-validation",
                        "reviewed_at": "2026-05-22T11:00:00Z",
                        "disposition": "reviewed_lab_record",
                    }
                ),
                encoding="utf-8",
            )
            matrix = write_yaml(
                tmp / "matrix.yaml",
                {
                    "schema": gate.EXPECTED_MATRIX_SCHEMA,
                    "acceptance_matrix": [{"path": log_rel, "evidence_kind": "executed_log"}],
                },
            )
            diagnostic = write_yaml(tmp / "diagnostic.yaml", {})
            with mock.patch.object(gate, "CHIP_ROOT", tmp):
                report = gate.build_report(matrix, diagnostic, tmp / "report.yaml")

        self.assertEqual(report["summary"]["present_contract_valid_log_count"], 1)
        self.assertFalse(report["summary"]["release_credit"])
        row = report["executed_log_contract_rows"][0]
        self.assertTrue(row["contract_valid"])
        self.assertFalse(row["release_credit"])
        self.assertEqual(row["validation_failures"], [])


if __name__ == "__main__":
    unittest.main()
