from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_tensor_numerics_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_tensor_numerics.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X tensor numerics" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_tensor_numerics.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-tensor-numerics"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["proof_layer_count"] == 283
    assert report["summary"]["schedule_layer_count"] == 283
    assert report["summary"]["placement_layer_count"] == 283
    assert report["summary"]["checked_mac_count"] == 26180
    assert report["summary"]["checked_row_count"] == 1132
    assert report["summary"]["total_assigned_cores"] == 151367
    assert report["summary"]["max_core_shard_bytes"] <= 48 * 1024
    assert set(report["summary"]["kind_counts"]) >= {
        "embedding",
        "norm",
        "attn_qkv_proj",
        "attn_out_proj",
        "mlp_gate_proj",
        "mlp_up_proj",
        "mlp_down_proj",
        "lm_head",
    }
