from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_k_repair_kind_coverage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_k_repair_kind_coverage.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_full_k_repair_kind_coverage.json").read_text())
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-K repair kind coverage" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["rung_count"] == 4
    assert summary["kind_count"] == 8
    assert summary["hyper_dense_row_count"] == 36_224
    assert summary["hyper_dense_mac_count"] == 176_957_568
    assert summary["hyper_dense_touched_logical_core_count"] == 25_937
    assert summary["hyper_dense_normal_remapped_rows"] == 44
    assert summary["hyper_dense_high_failure_remapped_rows"] == 760
    assert summary["hyper_dense_embedding_rows"] == 128
    assert summary["hyper_dense_lm_head_rows"] == 128
    assert summary["hyper_dense_norm_rows"] == 10_368
    assert summary["hyper_dense_attn_qkv_macs"] == 26_214_400
    assert summary["hyper_dense_mlp_down_macs"] == 70_778_880
    assert (
        summary["kind_rung_summary_sha256"]
        == "6d950882a3ecc98af6f0ae571a8c9715579b8850467694b18bcbf524976b4635"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
