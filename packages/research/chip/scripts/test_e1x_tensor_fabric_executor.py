from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_tensor_fabric_executor_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_tensor_fabric_executor.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X tensor fabric executor" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_tensor_fabric_executor.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["proof_layer_count"] == 283
    assert summary["merged_group_count"] == 283
    assert summary["merged_partial_count"] == 1132
    assert summary["executed_mac_count"] == 26180
    assert summary["scalar_cycle_count"] == 108116
    assert summary["merge_cycle_count"] == 1415
    assert summary["total_sampled_fabric_executor_cycles"] == 109531
    assert summary["reduction_merge_cocotb_testcases"] == 5
    assert summary["fabric_reduction_total_reduction_wavelets"] == 2_608_640
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
