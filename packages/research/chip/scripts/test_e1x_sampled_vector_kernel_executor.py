from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_sampled_vector_kernel_executor_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_sampled_vector_kernel_executor.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X sampled vector-kernel executor" in result.stdout
    report = json.loads(
        (ROOT / "build/reports/e1x_sampled_vector_kernel_executor.json").read_text()
    )
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["proof_layer_count"] == 283
    assert summary["executed_row_count"] == 1_132
    assert summary["executed_vector_word_op_count"] == 3_556
    assert summary["executed_lane_mac_count"] == 26_180
    assert summary["proof_aggregate_checksum"] == 32_681_797
    assert (
        summary["sampled_vector_trace_sha256"]
        == "f26180ab548688b9ff9f8f47bde426285c160ce99b08a55e6b35eed459ae607c"
    )
    assert (
        summary["per_layer_codegen_sha256"]
        == "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
    )
    assert summary["pe_cocotb_testcases"] >= 16
    assert summary["residual_blocker"] == "full_output_vector_kernel_execution_missing"
