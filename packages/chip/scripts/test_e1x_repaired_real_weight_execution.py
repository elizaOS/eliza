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
    assert summary["executed_layer_count"] == 83
    assert summary["executed_real_weight_row_count"] == 478_720
    assert summary["executed_real_weight_mac_count"] == 8_606_720
    assert summary["touched_logical_core_count"] == 3_847
    assert summary["output_invariant_checksum"] == 1_513_790_197_994_659_005
    assert summary["normal_route_checksum"] == 5_656_197_490_747_142_705
    assert summary["high_failure_route_checksum"] == 15_868_043_245_877_341_904
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 68
    assert summary["high_failure_touched_remapped_rows"] == 11_787
    assert summary["high_vs_normal_touched_remap_ratio"] > 170.0
    assert (
        summary["sampled_executed_rows_sha256"]
        == "692863e80ac6c9cb3cb10fe4a49bcf2d66c0183838cb76ab66378ffa41d8c605"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
