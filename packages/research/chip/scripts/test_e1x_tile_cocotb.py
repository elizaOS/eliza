from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_tile_cocotb_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_tile_cocotb.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X tile cocotb" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_tile_cocotb.json").read_text())
    assert report["status"] == "PASS"
    for claim_key in (
        "full_wafer_scale_claim_allowed",
        "full_riscv_compliance_claim_allowed",
        "pd_signoff_claim_allowed",
        "dft_claim_allowed",
        "package_claim_allowed",
        "silicon_claim_allowed",
        "release_claim_allowed",
    ):
        assert report[claim_key] is False
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["testcases"] == 12
    assert report["summary"]["real_graph_normal_repair_rom_sha256"]
    assert report["summary"]["real_graph_normal_repair_rom_words"] == 412
    assert report["summary"]["real_graph_high_failure_repair_rom_sha256"]
    assert report["summary"]["real_graph_high_failure_repair_rom_words"] == 3582
