from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_full_output_workplan_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_full_output_workplan.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X full-output workplan" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_full_output_workplan.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["workplan_layer_count"] == 283
    assert summary["full_output_row_count"] == 2_608_640
    assert summary["full_mac_count"] == 13_015_864_320
    assert summary["vector_word_op_count"] == 1_627_345_920
    assert summary["core_wave_count"] == 4_187_241
    assert summary["k_wave_count"] == 5_481
    assert summary["routing_color_count"] == 24
    assert summary["placed_core_count"] == 151_367
    assert summary["usable_bytes_per_core"] == 45_056
    assert summary["peak_core_shard_bytes"] == 43_520
    assert (
        summary["workplan_sha256"]
        == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
    )
    assert len(summary["all_workplan_records"]) == 283
    assert len(summary["sampled_workplan_records"]) == 8
    assert summary["sampled_executed_partial_count"] == 1_132
    assert summary["missing_output_row_count"] == 2_607_508
    assert summary["missing_mac_count"] == 13_015_838_140
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_kernel_execution_missing"
