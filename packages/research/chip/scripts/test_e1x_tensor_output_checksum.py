from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_tensor_output_checksum_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_tensor_output_checksum.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X tensor output checksum" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_tensor_output_checksum.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["proof_layer_count"] == 283
    assert summary["sampled_output_row_count"] == 1132
    assert summary["sampled_output_checksum"] == 14_414_877_542_268_347_137
    assert summary["normal_trace_output_checksum"] > 0
    assert summary["high_failure_trace_output_checksum"] > 0
    assert summary["normal_trace_output_checksum"] != summary["high_failure_trace_output_checksum"]
    assert summary["normal_trace_sampled_layers"] == 8
    assert summary["high_failure_trace_sampled_layers"] == 8
    assert summary["tensor_fabric_executor_merged_partials"] == 1132
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
