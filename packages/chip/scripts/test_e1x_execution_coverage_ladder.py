from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_execution_coverage_ladder_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_execution_coverage_ladder.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X execution coverage ladder" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_execution_coverage_ladder.json").read_text())
    assert report["status"] == "PASS"
    flags = {key: value for key, value in report.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["full_mac_count"] == 13_015_864_320
    assert summary["real_sampled_output_row_count"] == 1_132
    assert summary["real_sampled_mac_count"] == 26_180
    assert summary["deterministic_window_row_count"] == 2_608_640
    assert summary["deterministic_window_lane_mac_count"] == 70_620_160
    assert summary["deterministic_window_remaining_row_count"] == 0
    assert summary["row_coverage_gain_vs_real_sample"] > 2300.0
    assert summary["lane_mac_gain_vs_real_sample"] > 2600.0
    assert summary["sampled_output_checksum"] == 14_414_877_542_268_347_137
    assert summary["routed_window_checksum"] == 4_718_384_912_712_357_942
    assert summary["routing_color_count"] == 24
    assert summary["merged_group_count"] == 283
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
