from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_hyper_dense_stratified_full_k_repair_execution_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_hyper_dense_stratified_full_k_repair_execution.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_hyper_dense_stratified_full_k_repair_execution.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X hyper-dense stratified full-K repair execution" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_count"] == 283
    assert summary["executed_stratified_full_k_row_count"] == 36_224
    assert summary["executed_stratified_full_k_mac_count"] == 176_957_568
    assert summary["touched_logical_core_count"] == 25_937
    assert summary["output_invariant_checksum"] == 17_613_454_895_497_811_098
    assert summary["normal_route_checksum"] == 12_562_148_139_045_721_695
    assert summary["high_failure_route_checksum"] == 8_497_411_527_252_241_509
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 44
    assert summary["high_failure_touched_remapped_rows"] == 760
    assert summary["high_vs_normal_touched_remap_ratio"] == 17.272727272727273
    assert (
        summary["sampled_stratified_rows_sha256"]
        == "31f1aa362fceff9d7f16cc13f3ab5cca1d6cfff9026b1d955f1e145443ab1c0f"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
