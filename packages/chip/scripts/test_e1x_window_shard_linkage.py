from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_window_shard_linkage_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_window_shard_linkage.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X window-shard linkage" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_window_shard_linkage.json").read_text())
    assert report["status"] == "PASS"
    summary = report["summary"]
    assert summary["failing_check_count"] == 0
    assert summary["window_rows_per_layer"] == 32_768
    assert summary["placement_layer_count"] == 283
    assert summary["window_executed_row_count"] == 2_608_640
    assert summary["window_touched_shard_records"] == 151_367
    assert summary["window_touched_logical_cores"] == 151_367
    assert summary["window_touched_shard_bytes"] == 6_508_139_520
    assert summary["window_touched_loader_words"] == 1_627_034_880
    assert summary["total_programmed_shard_records"] == 151_367
    assert summary["total_stream_loader_word_transactions"] == 1_627_034_880
    assert summary["routed_window_checksum"] == 4_718_384_912_712_357_942
    assert (
        summary["touched_shard_record_sha256"]
        == "2d65679ad9dfcfe90582587e7ed2912d0e72d1d09c0d795087cb0e4ccb9e1f68"
    )
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
