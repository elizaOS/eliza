#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_npu_coverage_summary.py"


def load_check_module():
    spec = importlib.util.spec_from_file_location("check_npu_coverage_summary", CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class NpuCoverageSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gate = load_check_module()

    def test_current_summary_records_status_and_hashed_inputs(self) -> None:
        summary = self.gate.build_summary(self.gate.DEFAULT_COCOTB_COVERAGE)
        self.assertEqual(summary["schema"], "eliza.npu_local_coverage_summary.v1")
        self.assertEqual(summary["status"], "pass")
        self.assertEqual(summary["validation_errors"], [])
        self.assertEqual(summary["artifacts"]["runtime"]["sha256"], self.gate.artifact(self.gate.RUNTIME)["sha256"])
        self.assertEqual(
            summary["artifacts"]["runtime_contract"]["sha256"],
            self.gate.artifact(self.gate.CONTRACT)["sha256"],
        )
        self.assertEqual(
            summary["artifacts"]["cocotb_coverage"]["path"],
            "build/reports/npu_cocotb_coverage.json",
        )

    def test_invalid_coverage_records_fail_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            coverage = Path(tmpdir) / "coverage.json"
            coverage.write_text(
                json.dumps(
                    {
                        "schema": "eliza.npu_cocotb_coverage.v1",
                        "covered_opcodes": [],
                        "covered_opcode_names": [],
                        "descriptor_queue": {},
                        "perf_counters": [],
                        "status_bits": [],
                        "gemm_shapes": [],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            summary = self.gate.build_summary(coverage)
        self.assertEqual(summary["status"], "fail")
        self.assertIn("not all runtime contract opcodes are covered", summary["validation_errors"])


if __name__ == "__main__":
    unittest.main()
