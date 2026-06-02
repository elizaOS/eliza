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
    assert summary["touched_logical_core_count"] == 6_545
    assert summary["output_invariant_checksum"] == 13_739_606_427_776_396_480
    assert summary["normal_route_checksum"] == 17_541_455_524_737_409_381
    assert summary["high_failure_route_checksum"] == 185_044_992_303_269_905
    assert summary["normal_route_checksum"] != summary["high_failure_route_checksum"]
    assert summary["normal_touched_remapped_rows"] == 12
    assert summary["high_failure_touched_remapped_rows"] == 195
    assert summary["high_vs_normal_touched_remap_ratio"] == 16.25
    assert (
        summary["sampled_stratified_rows_sha256"]
        == "e6eec1eefdfbc6d2b146a5efde1c4ba149d188fa31156f3ca394674830a12768"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
