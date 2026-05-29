from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_tensor_cycle_executor_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_tensor_cycle_executor.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X tensor cycle executor" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_tensor_cycle_executor.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["gate"] == "e1x-tensor-cycle-executor"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["proof_layer_count"] == 283
    assert report["summary"]["executed_row_count"] == 1132
    assert report["summary"]["executed_mac_count"] == 26180
    assert report["summary"]["scalar_instruction_count"] == 108116
    assert report["summary"]["scalar_cycle_count"] == 108116
    assert report["summary"]["max_row_cycles"] > 0
    assert report["summary"]["pe_cocotb_testcases"] >= 16
    assert report["summary"]["residual_blocker"] == "vectorized_full_tensor_fabric_executor_missing"
    assert "not the vectorized full tensor" in report["claim_boundary"]
