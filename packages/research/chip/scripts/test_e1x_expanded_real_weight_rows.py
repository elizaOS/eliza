from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_expanded_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_expanded_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_expanded_real_weight_rows.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X expanded real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["placement_layer_count"] == 283
    assert summary["covered_kind_count"] == 8
    assert summary["executed_full_k_output_row_count"] == 849
    assert summary["executed_full_k_mac_count"] == 4_147_443
    assert 0.0003 < summary["row_coverage_fraction"] < 0.0004
    assert 0.0003 < summary["mac_coverage_fraction"] < 0.0004
    assert summary["mac_gain_vs_microkernel_proof"] > 158.0
    assert summary["expanded_full_k_checksum"] == 11_081_612_788_320_878_322
    assert (
        summary["sampled_layer_result_sha256"]
        == "2abc4cb9334b939b0b230cca5d4ad605ea35aba13a5940948601e52dd25ed117"
    )
    assert summary["microkernel_sample_mac_count"] == 26_180
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
