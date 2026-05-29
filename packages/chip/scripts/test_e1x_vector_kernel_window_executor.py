from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_vector_kernel_window_executor_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_vector_kernel_window_executor.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X vector-kernel window executor" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_vector_kernel_window_executor.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_rows_per_layer"] == 64
    assert summary["proof_layer_count"] == 283
    assert summary["executed_row_count"] == 18_112
    assert summary["executed_vector_word_op_count"] == 56_896
    assert summary["executed_lane_mac_count"] == 418_880
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["full_output_vector_word_op_count"] == 1_627_345_920
    assert summary["window_output_checksum"] == 3_343_337_413_686_647_285
    assert (
        summary["window_record_sha256"]
        == "092bb967317f1d7b65941a642e5a37264e490e6ce1f09948f22a3b2da4bd9313"
    )
    assert 0.006 < summary["window_row_coverage_fraction"] < 0.007
    assert (
        summary["sampled_vector_trace_sha256"]
        == "f26180ab548688b9ff9f8f47bde426285c160ce99b08a55e6b35eed459ae607c"
    )
    assert summary["residual_blocker"] == "full_output_vector_kernel_execution_missing"
