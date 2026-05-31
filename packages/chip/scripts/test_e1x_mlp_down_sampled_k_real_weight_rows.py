from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_mlp_down_sampled_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_mlp_down_sampled_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X mlp-down sampled-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_kind"] == "mlp_down_proj"
    assert summary["executed_layer_count"] == 40
    assert summary["sampled_k"] == 32
    assert summary["executed_mlp_down_output_row_count"] == 204_800
    assert summary["executed_mlp_down_sampled_k_mac_count"] == 6_553_600
    assert summary["represented_mlp_down_full_k_mac_count"] == 2_831_155_200
    assert 0.07 < summary["row_coverage_fraction"] < 0.08
    assert 0.0005 < summary["executed_mac_coverage_fraction"] < 0.001
    assert 0.21 < summary["represented_full_k_mac_fraction"] < 0.22
    assert summary["mlp_down_sampled_k_real_weight_checksum"] == 3_360_713_502_265_478_628
    assert (
        summary["mlp_down_sampled_k_result_sha256"]
        == "a3d640fdc0ae8a55cacdaa0e61bfbfdade39cf9b30d14c291656d579a6b26495"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
