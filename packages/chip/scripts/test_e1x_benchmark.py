from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_benchmark_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_benchmark.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X benchmark" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_benchmark.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["claim_level"] == "L2_ARCH_SIM"
    assert report["summary"]["scaled_local_sram_mib"] >= 8192
    assert report["summary"]["scaled_model_required_mib"] < report["summary"]["scaled_local_sram_mib"]
    assert report["summary"]["high_failure_prefill_ms"] > 0
    assert report["summary"]["high_failure_decode_tokens_per_second"] > 0
    assert report["summary"]["high_failure_output_checksum"] > 0
    assert (
        report["summary"]["high_failure_execution_trace_output_checksum"]
        == report["summary"]["high_failure_output_checksum"]
    )
    assert report["summary"]["high_failure_execution_trace_total_cycles"] > 0
