from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_repaired_real_weight_execution_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_repaired_real_weight_execution.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_repaired_real_weight_execution.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X repaired real-weight execution" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_count"] == 283
    assert summary["executed_real_weight_row_count"] == 2_608_640
    assert summary["executed_real_weight_mac_count"] == 83_317_760
    assert summary["touched_logical_core_count"] == 151_367
    assert summary["output_invariant_checksum"] == 7_830_244_848_299_761_912
    assert summary["normal_route_checksum"] == 3_248_974_677_569_690_675
    assert summary["high_failure_route_checksum"] == 36_983_080_900_949_662
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 4_069
    assert summary["high_failure_touched_remapped_rows"] == 54_211
    assert summary["high_vs_normal_touched_remap_ratio"] > 13.0
    assert (
        summary["sampled_executed_rows_sha256"]
        == "692863e80ac6c9cb3cb10fe4a49bcf2d66c0183838cb76ab66378ffa41d8c605"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
