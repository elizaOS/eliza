from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_k_repair_route_cost_by_kind_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_k_repair_route_cost_by_kind.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads(
        (ROOT / "build/reports/e1x_full_k_repair_route_cost_by_kind.json").read_text()
    )
    summary = report["summary"]
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X full-K repair route cost by kind" in result.stdout
    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["normal_kind_count"] == 5
    assert summary["high_failure_kind_count"] == 8
    assert summary["normal_total_kind_remapped_rows"] == 44
    assert summary["high_failure_total_kind_remapped_rows"] == 760
    assert summary["normal_total_kind_remap_distance"] == 6_824
    assert summary["high_failure_total_kind_remap_distance"] == 107_180
    assert summary["high_failure_norm_remapped_rows"] == 256
    assert summary["high_failure_norm_remap_distance"] == 29_696
    assert summary["high_failure_attn_qkv_remapped_rows"] == 109
    assert summary["high_failure_attn_qkv_remap_distance"] == 17_494
    assert summary["high_failure_mlp_down_remap_distance"] == 14_055
    assert summary["high_vs_normal_kind_count_ratio"] == 1.6
    assert summary["high_vs_normal_remapped_row_ratio"] > 17.0
    assert summary["high_vs_normal_remap_distance_ratio"] > 15.0
    assert (
        summary["kind_route_cost_summary_sha256"]
        == "ae668566b1f994acb9c322b9d3e2b257dc69e33873e500fbc47fa5f1f9ed2703"
    )
    assert summary["residual_blocker"] == "full_output_real_weight_checksum_missing"
