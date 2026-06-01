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
        self.assertIn("generated_utc", summary)
        self.assertEqual(summary["validation_errors"], [])
        self.assertFalse(summary["phone_claim_allowed"])
        self.assertFalse(summary["release_claim_allowed"])
        self.assertFalse(summary["production_accelerator_claim_allowed"])
        self.assertFalse(summary["nnapi_claim_allowed"])
        self.assertFalse(summary["performance_claim_allowed"])
        for claim in self.gate.RAW_FALSE_CLAIM_FLAGS:
            self.assertIs(summary["raw_cocotb_claim_flags"][claim], False)
        self.assertIn(
            "DMA-backed tensor execution readiness.",
            summary["claim_boundary"]["blocked_claims"],
        )
        self.assertFalse(summary["claim_boundary"]["dma_backed_tensor_execution"])
        self.assertEqual(
            summary["artifacts"]["runtime"]["sha256"],
            self.gate.artifact(self.gate.RUNTIME)["sha256"],
        )
        self.assertEqual(
            summary["artifacts"]["runtime_contract"]["sha256"],
            self.gate.artifact(self.gate.CONTRACT)["sha256"],
        )
        self.assertEqual(
            summary["artifacts"]["cocotb_coverage"]["path"],
            "build/reports/npu_cocotb_coverage.json",
        )
        self.assertTrue(summary["artifacts"]["cocotb_results"]["exists"])
        self.assertTrue(all(result["all_passed"] for result in summary["directed_tests"].values()))
        self.assertTrue(summary["saturation_cases"]["relu4_negative_lanes_zeroed"])
        self.assertTrue(summary["invalid_programming_cases"]["descriptor_timeout"])
        self.assertTrue(summary["irq_paths"]["error_irq_clear_deasserts"])
        self.assertTrue(all(summary["software_fallback_cases"]["source_tests"].values()))

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
                        **{claim: False for claim in self.gate.RAW_FALSE_CLAIM_FLAGS},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            summary = self.gate.build_summary(coverage)
        self.assertEqual(summary["status"], "fail")
        self.assertIn("not all runtime contract opcodes are covered", summary["validation_errors"])
        self.assertIn("GEMM_S4 shape coverage is missing", summary["validation_errors"])

    def test_raw_cocotb_false_claim_drift_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            coverage = Path(tmpdir) / "coverage.json"
            data = json.loads(self.gate.DEFAULT_COCOTB_COVERAGE.read_text(encoding="utf-8"))
            data["release_claim_allowed"] = True
            data.pop("nnapi_claim_allowed", None)
            coverage.write_text(json.dumps(data) + "\n", encoding="utf-8")

            summary = self.gate.build_summary(coverage)

        self.assertEqual(summary["status"], "fail")
        self.assertIn(
            "raw_cocotb_claim_flags.release_claim_allowed must be false",
            summary["validation_errors"],
        )
        self.assertIn(
            "raw_cocotb_claim_flags.nnapi_claim_allowed must be false",
            summary["validation_errors"],
        )

    def test_missing_results_xml_fails_directed_test_bins(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            missing_results = Path(tmpdir) / "missing.xml"
            summary = self.gate.build_summary(
                self.gate.DEFAULT_COCOTB_COVERAGE,
                missing_results,
            )
        self.assertEqual(summary["status"], "fail")
        self.assertTrue(
            any(
                error.startswith("directed cocotb tests missing for irq_paths")
                for error in summary["validation_errors"]
            )
        )


if __name__ == "__main__":
    unittest.main()
