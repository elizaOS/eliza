from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_stratified_full_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_stratified_full_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_stratified_full_k_real_weight_rows.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X stratified full-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["placement_layer_count"] == 283
    assert summary["rows_per_layer_target"] == 16
    assert summary["executed_stratified_full_k_output_row_count"] == 4_528
    assert summary["executed_stratified_full_k_mac_count"] == 22_119_696
    assert 0.001 < summary["row_coverage_fraction"] < 0.002
    assert 0.001 < summary["mac_coverage_fraction"] < 0.002
    assert summary["mac_gain_vs_expanded_full_k_rows"] == 5.333333333333333
    assert summary["stratified_full_k_checksum"] == 13_706_112_457_522_307_321
    assert (
        summary["stratified_layer_result_sha256"]
        == "44653e48fe734bd4fd981b41484c6068ed7bdfeb67cee889e854d1649cf4ed91"
    )
    assert summary["kind_row_counts"]["mlp_down_proj"] == 640
    assert summary["kind_mac_counts"]["mlp_down_proj"] == 8_847_360
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
