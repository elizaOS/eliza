from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_vector_window_fabric_checksum_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_vector_window_fabric_checksum.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X vector-window fabric checksum" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_vector_window_fabric_checksum.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_rows_per_layer"] == 64
    assert summary["proof_layer_count"] == 283
    assert summary["executed_row_count"] == 18_112
    assert summary["executed_vector_word_op_count"] == 56_896
    assert summary["executed_lane_mac_count"] == 418_880
    assert summary["merged_group_count"] == 283
    assert summary["window_merge_cycle_count"] == 18_395
    assert summary["routing_color_count"] == 24
    assert summary["routed_window_checksum"] == 15_818_110_737_476_397_592
    assert (
        summary["color_record_sha256"]
        == "2aaa032111875f3ea5d2283aa0447bae2c97d8dbcc6099d1c23c97b165501bbf"
    )
    assert summary["vector_window_checksum"] == 3_343_337_413_686_647_285
    assert summary["reduction_merge_cocotb_testcases"] >= 5
    assert summary["fabric_reduction_total_reduction_wavelets"] == 2_608_640
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
