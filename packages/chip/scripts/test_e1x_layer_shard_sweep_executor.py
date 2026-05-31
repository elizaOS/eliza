from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_layer_shard_sweep_executor_covers_every_layer() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_layer_shard_sweep_executor.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X layer-shard sweep executor" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_layer_shard_sweep_executor.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["placement_layer_count"] == 283
    assert summary["covered_layer_count"] == 283
    assert summary["covered_kind_count"] == 8
    assert summary["sampled_shard_record_count"] == 687
    assert summary["executed_loader_word_count"] == 5_064_960
    assert summary["executed_lane_mac_count"] == 40_519_680
    assert summary["total_loader_word_transactions"] == 1_627_034_880
    assert summary["loader_word_coverage_fraction"] == 0.0031130002572532433
    assert summary["activation_value_count"] == 32
    assert summary["aggregate_execution_checksum"] == 7_249_510_583_533_139_077
    assert (
        summary["sampled_result_sha256"]
        == "a411c16bcfd5388c12fcd4b68f962bf4f5560bc1ee5189a8c39eb1d9e6c4f5aa"
    )
    assert summary["residual_blocker"] == "full_quantized_weight_payload_executor_missing"
