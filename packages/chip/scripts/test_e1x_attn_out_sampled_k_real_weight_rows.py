from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_attn_out_sampled_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_attn_out_sampled_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X attn-out sampled-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_kind"] == "attn_out_proj"
    assert summary["executed_layer_count"] == 40
    assert summary["sampled_k"] == 64
    assert summary["executed_attn_out_output_row_count"] == 204_800
    assert summary["executed_attn_out_sampled_k_mac_count"] == 13_107_200
    assert summary["represented_attn_out_full_k_mac_count"] == 1_048_576_000
    assert 0.07 < summary["row_coverage_fraction"] < 0.09
    assert 0.001 < summary["executed_mac_coverage_fraction"] < 0.002
    assert 0.08 < summary["represented_full_k_mac_fraction"] < 0.09
    assert summary["attn_out_sampled_k_real_weight_checksum"] == 6_608_415_098_217_527_669
    assert (
        summary["attn_out_sampled_k_result_sha256"]
        == "eb125c171f915724c435bb531c3e46399daeef673edb4e2c571b93b1fd0487aa"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
