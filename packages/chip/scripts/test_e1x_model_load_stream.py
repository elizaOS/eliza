from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_model_load_stream_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_model_load_stream.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X model-load stream" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_model_load_stream.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-model-load-stream"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["layer_count"] == 283
    assert report["summary"]["programmed_shard_records"] == 151367
    assert report["summary"]["unique_logical_cores"] == 151367
    assert report["summary"]["max_shard_bytes"] == 43520
    assert report["summary"]["placement_usable_bytes_per_core"] == 45056
    assert report["summary"]["reserve_policy_mismatch_bytes"] == 0
    assert (
        report["summary"]["stream_loader_word_transactions"]
        >= report["summary"]["fabric_load_wavelets"]
    )
    assert (
        report["summary"]["stream_padding_bytes"] < report["summary"]["total_weight_bytes"] * 0.001
    )
    assert report["summary"]["generated_shard_sample_words"] == 9_282
    assert report["summary"]["core_cocotb_testcases"] >= 22
    assert report["summary"]["residual_blocker"] == "cycle_accurate_full_tensor_executor_missing"
    assert "not a cycle-accurate full tensor executor" in report["claim_boundary"]
