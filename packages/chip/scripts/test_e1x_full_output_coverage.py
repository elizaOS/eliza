from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_output_coverage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_output_coverage.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X full-output coverage" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_output_coverage.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["scheduled_layer_count"] == 283
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["sampled_output_row_count"] == 1132
    assert summary["missing_output_row_count"] == 2_607_508
    assert 0.0 < summary["output_row_coverage_fraction"] < 0.001
    assert summary["full_mac_count"] == 13_015_864_320
    assert summary["sampled_mac_count"] == 26_180
    assert summary["missing_mac_count"] == 13_015_838_140
    assert 0.0 < summary["mac_coverage_fraction"] < 0.001
    assert summary["placed_core_count"] == 151_367
    assert summary["model_weight_bytes"] == 6_507_932_160
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
