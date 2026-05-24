#!/usr/bin/env python3
"""Tests for check_linux_multiarch_gui_parity.py."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "check_linux_multiarch_gui_parity.py"
spec = importlib.util.spec_from_file_location("check_linux_multiarch_gui_parity", MODULE_PATH)
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


class LinuxMultiarchGuiParityTests(unittest.TestCase):
    def test_current_report_blocks_until_arm64_gui_and_boot_evidence_pass(self) -> None:
        report = gate.build_report()
        self.assertEqual(report["schema"], gate.SCHEMA)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["arches"]["riscv64"]["proof_state"], "proven")
        self.assertEqual(report["arches"]["arm64"]["proof_state"], "blocked")
        self.assertGreaterEqual(len(report["findings"]), 1)

    def test_all_arches_pass_when_gui_reports_and_matrix_are_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "multiarch_boot_matrix.json"
            arm64 = root / "arm64_gui.json"
            riscv64 = root / "riscv64_gui.json"
            write_json(
                matrix,
                {
                    "schema": gate.REQUIRED_MATRIX_SCHEMA,
                    "architectures": [
                        {
                            "arch": "arm64",
                            "status": "candidate",
                            "iso": "out/arm64.iso",
                            "evidence": "evidence/arm64_boot.json",
                        },
                        {
                            "arch": "riscv64",
                            "status": "candidate",
                            "iso": "out/riscv64.iso",
                            "evidence": "evidence/riscv64_boot.json",
                        },
                    ],
                },
            )
            for arch, path in {"arm64": arm64, "riscv64": riscv64}.items():
                write_json(
                    path,
                    {
                        "schema": gate.REQUIRED_GUI_SCHEMA,
                        "status": "pass",
                        "arch": arch,
                        "claim_boundary": "static ISO payload check",
                    },
                )

            old_matrix = gate.MATRIX
            old_reports = gate.REPORTS
            gate.MATRIX = matrix
            gate.REPORTS = {"arm64": arm64, "riscv64": riscv64}
            try:
                report = gate.build_report()
            finally:
                gate.MATRIX = old_matrix
                gate.REPORTS = old_reports

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["proven_arches"], 2)
        self.assertEqual(report["summary"]["gui_payload_proven_arches"], 2)
        self.assertEqual(report["findings"], [])

    def test_gui_payload_pass_is_visible_even_before_boot_matrix_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "multiarch_boot_matrix.json"
            arm64 = root / "arm64_gui.json"
            riscv64 = root / "riscv64_gui.json"
            write_json(
                matrix,
                {
                    "schema": gate.REQUIRED_MATRIX_SCHEMA,
                    "architectures": [
                        {"arch": "arm64", "status": "missing-current-iso-evidence"},
                        {
                            "arch": "riscv64",
                            "status": "candidate",
                            "iso": "out/riscv64.iso",
                            "evidence": "evidence/riscv64_boot.json",
                        },
                    ],
                },
            )
            for arch, path in {"arm64": arm64, "riscv64": riscv64}.items():
                write_json(
                    path,
                    {
                        "schema": gate.REQUIRED_GUI_SCHEMA,
                        "status": "pass",
                        "arch": arch,
                        "claim_boundary": "static ISO payload check",
                    },
                )

            old_matrix = gate.MATRIX
            old_reports = gate.REPORTS
            gate.MATRIX = matrix
            gate.REPORTS = {"arm64": arm64, "riscv64": riscv64}
            try:
                report = gate.build_report()
            finally:
                gate.MATRIX = old_matrix
                gate.REPORTS = old_reports

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["proven_arches"], 1)
        self.assertEqual(report["summary"]["gui_payload_proven_arches"], 2)
        self.assertEqual(report["arches"]["arm64"]["gui_payload_state"], "proven")
        self.assertEqual(report["arches"]["arm64"]["proof_state"], "blocked")

    def test_missing_gui_report_is_structured_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "multiarch_boot_matrix.json"
            write_json(matrix, {"schema": gate.REQUIRED_MATRIX_SCHEMA, "architectures": []})
            old_matrix = gate.MATRIX
            old_reports = gate.REPORTS
            gate.MATRIX = matrix
            gate.REPORTS = {"arm64": root / "missing.json", "riscv64": root / "missing2.json"}
            try:
                report = gate.build_report()
            finally:
                gate.MATRIX = old_matrix
                gate.REPORTS = old_reports
        codes = {item["code"] for item in report["findings"]}
        self.assertIn("linux_multiarch_gui_arm64_report_missing", codes)
        self.assertIn("linux_multiarch_gui_riscv64_report_missing", codes)


if __name__ == "__main__":
    unittest.main()
