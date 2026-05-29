from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_evidence_bundle_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_evidence_bundle.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X evidence bundle" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_evidence_bundle.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["evidence_path_check_count"] == 12
    assert report["summary"]["freshness_check_count"] == 12
    assert report["summary"]["real_graph_model_required_vs_e1_sram"] > 100
    assert 0.0 < report["summary"]["real_graph_model_required_vs_e1x_sram"] < 1.0
    assert report["summary"]["boot_verified_rom_case_count"] == 3
    assert report["summary"]["repair_rom_cocotb_testcases"] >= 16
    assert report["summary"]["tile_cocotb_testcases"] >= 12
    assert report["summary"]["core_cocotb_testcases"] >= 22
    assert report["summary"]["pe_core_cocotb_testcases"] >= 16
    assert report["summary"]["dft_cocotb_testcases"] >= 7
    assert report["summary"]["graph_mapper_passing_check_count"] >= 8
