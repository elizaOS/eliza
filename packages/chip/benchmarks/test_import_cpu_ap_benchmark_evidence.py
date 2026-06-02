#!/usr/bin/env python3
"""Tests for generated AP benchmark evidence import."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "benchmarks/import_cpu_ap_benchmark_evidence.py"


def load_importer():
    sys.path.insert(0, str(ROOT / "benchmarks"))
    spec = importlib.util.spec_from_file_location("import_cpu_ap_benchmark_evidence", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ImportCpuApBenchmarkEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.importer = load_importer()

    def test_report_has_top_level_provenance_and_claim_boundary(self) -> None:
        report = self.importer.build_report(self.importer.DEFAULT_EVIDENCE)

        self.assertEqual(report["schema"], "eliza.benchmark_run.v1")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["claim_boundary"], self.importer.CLAIM_BOUNDARY)
        self.assertEqual(report["generated_utc"], report["date_utc"])
        self.assertFalse(report["phone_claim_allowed"])
        self.assertFalse(report["release_claim_allowed"])
        self.assertTrue(report["results"])
        self.assertEqual(
            report["artifacts"]["target_metadata_contract"],
            "benchmarks/configs/target-metadata.contract.json",
        )
        self.assertRegex(report["artifacts"]["target_metadata_contract_sha256"], r"^[0-9a-f]{64}$")
        self.assertGreater(report["artifacts"]["target_metadata_contract_bytes"], 0)
        self.assertTrue(
            all(
                result["metrics"]["claim_boundary"] == self.importer.CLAIM_BOUNDARY
                for result in report["results"]
            )
        )

    def test_report_preserves_sanitized_runtime_metadata(self) -> None:
        report = self.importer.build_report(self.importer.DEFAULT_EVIDENCE)
        metadata = report["source_transcript_metadata"]

        self.assertEqual(
            metadata["source_transcript"], "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
        )
        self.assertTrue(metadata["source_transcript_sha256"])
        self.assertNotIn("/home/", metadata["source_command"])
        self.assertEqual(
            metadata["generated_manifest"],
            "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
        )
        self.assertTrue(metadata["raw_transcript_markers"]["begin"])
        self.assertTrue(metadata["raw_transcript_markers"]["end"])
        self.assertTrue(metadata["raw_transcript_markers"]["wrapper_pass"])
        self.assertTrue(metadata["runtime_target"]["opensbi_seen"])
        self.assertTrue(metadata["runtime_target"]["linux_version_seen"])
        self.assertTrue(metadata["runtime_target"]["rv64gc_hwprobe_seen"])
        self.assertEqual(metadata["benchmark_contract"]["claim_level"], "L3")
        self.assertEqual(metadata["benchmark_contract"]["run_count"], 1)
        self.assertIn(
            "no board power rail measurement",
            metadata["benchmark_contract"]["power_method"],
        )
        self.assertTrue(metadata["npu_smoke_context"]["present"])
        self.assertEqual(metadata["npu_smoke_context"]["cpu_fallback_percent"], 0)
        self.assertFalse(metadata["claim_exclusions"]["phone_or_android_runtime_claim"])
        self.assertFalse(metadata["claim_exclusions"]["board_power_rail_measurement"])


if __name__ == "__main__":
    unittest.main()
