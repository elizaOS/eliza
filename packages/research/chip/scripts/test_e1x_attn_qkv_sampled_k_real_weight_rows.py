from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_attn_qkv_sampled_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_attn_qkv_sampled_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X attn-qkv sampled-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_kind"] == "attn_qkv_proj"
    assert summary["executed_layer_count"] == 40
    assert summary["sampled_k"] == 32
    assert summary["executed_attn_qkv_output_row_count"] == 614_400
    assert summary["executed_attn_qkv_sampled_k_mac_count"] == 19_660_800
    assert summary["represented_attn_qkv_full_k_mac_count"] == 3_145_728_000
    assert 0.23 < summary["row_coverage_fraction"] < 0.24
    assert 0.001 < summary["executed_mac_coverage_fraction"] < 0.002
    assert 0.24 < summary["represented_full_k_mac_fraction"] < 0.25
    assert summary["attn_qkv_sampled_k_real_weight_checksum"] == 16_749_998_878_173_451_739
    assert (
        summary["attn_qkv_sampled_k_result_sha256"]
        == "7774d62c42840b0bf66082fa7e072df8f4ee9067f659451e7195488f57f74940"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
