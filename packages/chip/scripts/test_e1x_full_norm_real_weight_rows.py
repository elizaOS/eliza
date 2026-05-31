from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_norm_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_norm_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_full_norm_real_weight_rows.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full norm real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_kind"] == "norm"
    assert summary["executed_norm_layer_count"] == 81
    assert summary["executed_norm_output_row_count"] == 414_720
    assert summary["executed_norm_mac_count"] == 414_720
    assert 0.15 < summary["row_coverage_fraction"] < 0.17
    assert 0.0 < summary["mac_coverage_fraction"] < 0.0001
    assert summary["full_norm_real_weight_checksum"] == 1_566_824_365_644_515_702
    assert (
        summary["sampled_norm_result_sha256"]
        == "e83b0a710f70a39f82b10ff34593f0b0dc2ca95fd095e2b7ee76a5946bc9b488"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
