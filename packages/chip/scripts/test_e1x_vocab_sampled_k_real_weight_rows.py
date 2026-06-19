from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_vocab_sampled_k_real_weight_rows_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_vocab_sampled_k_real_weight_rows.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_vocab_sampled_k_real_weight_rows.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X vocab sampled-K real-weight rows" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["executed_layer_count"] == 2
    assert summary["sampled_k"] == 128
    assert summary["executed_vocab_output_row_count"] == 64_000
    assert summary["executed_vocab_sampled_k_mac_count"] == 8_192_000
    assert summary["represented_vocab_full_k_mac_count"] == 327_680_000
    assert 0.02 < summary["row_coverage_fraction"] < 0.03
    assert 0.0006 < summary["executed_mac_coverage_fraction"] < 0.0007
    assert 0.02 < summary["represented_full_k_mac_fraction"] < 0.03
    assert summary["vocab_sampled_k_real_weight_checksum"] == 2_937_447_206_589_032_094
    assert (
        summary["vocab_sampled_k_result_sha256"]
        == "eefae909eba8d90f14e4b04daee33f994e791f8be981fd2dcfa1fe3fdc5bf084"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
    assert report["full_output_execution_claim_allowed"] is False
    assert report["real_model_full_output_claim_allowed"] is False
