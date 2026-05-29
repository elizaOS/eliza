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
    assert summary["window_rows_per_layer"] == 64
    assert summary["placement_layer_count"] == 283
    assert summary["window_executed_row_count"] == 18_112
    assert summary["window_touched_shard_records"] == 1_169
    assert summary["window_touched_logical_cores"] == 1_169
    assert summary["window_touched_shard_bytes"] == 44_241_984
    assert summary["window_touched_loader_words"] == 11_060_496
    assert summary["total_programmed_shard_records"] == 151_367
    assert summary["total_stream_loader_word_transactions"] == 1_627_034_880
    assert summary["routed_window_checksum"] == 15_818_110_737_476_397_592
    assert (
        summary["touched_shard_record_sha256"]
        == "1380e6e328093661e5e6b89502ec174551aaab8a3d6b75d4734b719af4afe47c"
    )
    assert summary["residual_blocker"] == "full_output_vectorized_tensor_fabric_executor_missing"
