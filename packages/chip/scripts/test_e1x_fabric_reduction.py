from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_fabric_reduction_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_fabric_reduction.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X fabric reduction" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_fabric_reduction.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["scheduled_layer_count"] == 283
    assert summary["routing_color_count"] == 24
    assert summary["used_routing_color_count"] == 24
    assert summary["total_activation_wavelets"] == 267_978_321
    assert summary["total_reduction_wavelets"] == 2_608_640
    assert summary["total_fabric_wavelets"] == 270_586_961
    assert summary["peak_routing_color"] == 18
    assert summary["peak_color_fabric_cycles"] == 260_428
    assert summary["reduction_merge_cocotb_testcases"] == 5
    assert summary["residual_blocker"] == "vectorized_full_tensor_fabric_executor_missing"
