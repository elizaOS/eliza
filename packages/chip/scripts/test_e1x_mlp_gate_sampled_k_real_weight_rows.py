from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_mlp_gate_sampled_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_mlp_gate_sampled_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X mlp-gate sampled-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_kind"] == "mlp_gate_proj"
    assert summary["executed_layer_count"] == 40
    assert summary["sampled_k"] == 32
    assert summary["executed_mlp_gate_output_row_count"] == 552_960
    assert summary["executed_mlp_gate_sampled_k_mac_count"] == 17_694_720
    assert summary["represented_mlp_gate_full_k_mac_count"] == 2_831_155_200
    assert 0.21 < summary["row_coverage_fraction"] < 0.22
    assert 0.001 < summary["executed_mac_coverage_fraction"] < 0.002
    assert 0.21 < summary["represented_full_k_mac_fraction"] < 0.22
    assert summary["mlp_gate_sampled_k_real_weight_checksum"] == 644_049_328_919_108_482
    assert (
        summary["mlp_gate_sampled_k_result_sha256"]
        == "042143af521f945995b1862636d90a6668be8a9fc68d776ff800251ffc4e3fc4"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
