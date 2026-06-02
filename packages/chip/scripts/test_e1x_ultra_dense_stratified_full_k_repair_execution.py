from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_ultra_dense_stratified_full_k_repair_execution_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_ultra_dense_stratified_full_k_repair_execution.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X ultra-dense stratified full-K repair execution" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_count"] == 283
    assert summary["executed_stratified_full_k_row_count"] == 18_112
    assert summary["executed_stratified_full_k_mac_count"] == 88_478_784
    assert summary["touched_logical_core_count"] == 13_009
    assert summary["output_invariant_checksum"] == 1_604_437_103_023_062_119
    assert summary["normal_route_checksum"] == 7_195_579_865_255_220_347
    assert summary["high_failure_route_checksum"] == 13_035_249_012_885_092_373
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 23
    assert summary["high_failure_touched_remapped_rows"] == 406
    assert summary["high_vs_normal_touched_remap_ratio"] == 17.652173913043477
    assert (
        summary["sampled_stratified_rows_sha256"]
        == "549b0da412404be0f41351fa4bdb79883089306bc480515e8eb89f6467682b7d"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
