#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import check_memory_evidence_templates as templates


def valid_real_report() -> dict:
    return {
        "schema": "eliza.memory.lpddr_bandwidth_latency_benchmark.v1",
        "evidence_class": "real_target_measurement",
        "target": {
            "target_id": "fpga-lab-target-01",
            "target_kind": "fpga_emulation",
            "is_host": False,
            "is_simulator": False,
            "capture_utc": "2026-05-18T00:00:00Z",
        },
        "process_corners": {
            "process_effects_contract": {
                "path": "docs/spec-db/process-14a-effects.yaml",
                "sha256": "a" * 64,
            },
            "process_corner_count": 4,
            "worst_process_corner": "14a_ss_0p63v_105c_frontside_pdn",
            "pdk_signoff_claim": "none",
        },
        "memory_config": {
            "memory_type": "LPDDR6 measured target",
            "capacity_gib": 16,
        },
        "benchmark_commands": ["stream_c.exe", "lat_mem_rd 64M 128"],
        "raw_artifacts": [{"path": "docs/evidence/memory/raw/lpddr.log", "sha256": "b" * 64}],
        "parsed_metrics": {
            "peak_bandwidth_gbps": 180.0,
            "sustained_bandwidth_gbps": 128.0,
            "p95_random_read_latency_ns": 95.0,
            "contended_cpu_latency_ns": 110.0,
            "display_underflow_count": 0,
            "dma_copy_bandwidth_gbps": 64.0,
            "worst_process_corner_sustained_bandwidth_gbps": 121.0,
            "worst_process_corner_p95_random_read_latency_ns": 119.0,
        },
    }


class MemoryEvidenceTemplateTest(unittest.TestCase):
    def test_template_checker_passes_without_real_reports(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_memory_evidence_templates.py"],
            cwd=templates.ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("template_only", templates.TEMPLATE.read_text())
        self.assertIn("placeholder rejection is armed", result.stdout)

    def test_placeholder_real_report_is_rejected(self) -> None:
        report = json.loads(templates.TEMPLATE.read_text())["report"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "placeholder-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains placeholders", result.stdout)

    def test_real_report_without_process_contract_hash_is_rejected(self) -> None:
        report = valid_real_report()
        report["process_corners"]["process_effects_contract"]["sha256"] = "__REQUIRED_SHA256__"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-process-hash.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains placeholders", result.stdout)

    def test_real_report_without_process_corner_metrics_is_rejected(self) -> None:
        report = valid_real_report()
        del report["parsed_metrics"]["worst_process_corner_sustained_bandwidth_gbps"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-process-metric.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing metrics", result.stdout)


if __name__ == "__main__":
    unittest.main()
