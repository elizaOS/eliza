from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_model_shard_sample_executor_runs_actual_loaded_words() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_model_shard_sample_executor.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stdout
    assert "PASS: E1X model-shard sample executor" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_model_shard_sample_executor.json").read_text())
    summary = report["summary"]

    assert report["status"] == "PASS"
    assert summary["failing_check_count"] == 0
    assert summary["sampled_word_count"] == 9_282
    assert summary["weight_shard_word_count"] == 9_281
    assert summary["sampled_shard_word_count"] == 9_281
    assert summary["sentinel_word_addr"] == 12287
    assert summary["expected_checksum"] == 3_823_329_054
    assert summary["recomputed_loader_checksum"] == 3_823_329_054
    assert summary["sampled_loaded_bytes"] == 37_128
    assert summary["total_loader_word_transactions"] == 1_627_034_880
    assert summary["sample_word_coverage_fraction"] == 5.7048561859964555e-06
    assert summary["activation_value_count"] == 32
    assert summary["executed_lane_mac_count"] == 74_256
    assert summary["sample_accumulator"] == -394_963
    assert summary["sample_requantized_s8"] == -128
    assert summary["sample_execution_checksum"] == 6_658_997_565_743_609_885
    assert (
        summary["sample_payload_sha256"]
        == "f8fde8061d500fbef0cb3c6a4225e42abb11aba38da814b1c00a830c7dbf6910"
    )
    assert summary["residual_blocker"] == "full_quantized_weight_payload_executor_missing"
