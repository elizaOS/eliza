from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_dense_stratified_full_k_repair_execution_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_dense_stratified_full_k_repair_execution.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_dense_stratified_full_k_repair_execution.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X dense stratified full-K repair execution" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_count"] == 283
    assert summary["executed_stratified_full_k_row_count"] == 9_056
    assert summary["executed_stratified_full_k_mac_count"] == 44_239_392
    assert summary["touched_logical_core_count"] > 3_313
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 5
    assert summary["high_failure_touched_remapped_rows"] == 97
    assert summary["high_vs_normal_touched_remap_ratio"] == 19.4
    assert (
        summary["sampled_stratified_rows_sha256"]
        == "bde87dfb102b537486283d80fb831738b837fd56f332553f348beda75a132bb7"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
