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
    flags = {key: value for key, value in report.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_rows_per_layer"] == 32_768
    assert summary["proof_layer_count"] == 283
    assert summary["executed_row_count"] == 2_608_640
    assert summary["executed_vector_word_op_count"] == 9_190_400
    assert summary["executed_lane_mac_count"] == 70_620_160
    assert summary["merged_group_count"] == 283
    assert summary["window_merge_cycle_count"] == 2_608_923
    assert summary["routing_color_count"] == 24
    assert summary["routed_window_checksum"] == 4_718_384_912_712_357_942
    assert (
        summary["color_record_sha256"]
        == "0de6d5fb8a46de54765f2f301a1fcc5407dcf4ec29ac05023056267019201bd0"
    )
    assert summary["vector_window_checksum"] == 4_033_574_925_821_332_798
    assert summary["reduction_merge_cocotb_testcases"] >= 5
    assert summary["fabric_reduction_total_reduction_wavelets"] == 2_608_640
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
