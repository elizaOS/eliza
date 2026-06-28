from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_rtl_contract_gate_passes_or_only_blocks_optional_lint() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_rtl_contract.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X RTL contract check" in result.stdout

    report = json.loads((ROOT / "build/reports/e1x_rtl_contract.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["status"] == "PASS"
    assert report["subsystem"] == "e1x"
    for claim_key in (
        "full_riscv_compliance_claim_allowed",
        "wafer_scale_rtl_claim_allowed",
        "pd_signoff_claim_allowed",
        "dft_claim_allowed",
        "package_claim_allowed",
        "silicon_claim_allowed",
        "release_claim_allowed",
    ):
        assert report[claim_key] is False
    assert report["summary"]["failing_check_count"] == 0

    checks = {check["id"]: check for check in report["checks"]}
    assert checks["e1x_rtl_params_match_model"]["status"] == "pass"
    assert checks["e1x_model_repairs_defect_map"]["status"] == "pass"
    assert checks["e1x_tile_binds_core_and_router"]["status"] == "pass"
    assert checks["e1x_credit_router_supports_lossless_flow_control"]["status"] == "pass"
    assert checks["e1x_pe_core_supports_rv64im_wavelet_execution"]["status"] == "pass"
    assert checks["e1x_reduction_merge_supports_bounded_tensor_partials"]["status"] == "pass"
    assert checks["e1x_reduction_merge_verilator_lint"]["status"] == "pass"
    assert checks["e1x_sram_ecc_supports_local_sram_integrity"]["status"] == "pass"
    assert checks["e1x_mbist_supports_local_sram_manufacturing_test"]["status"] == "pass"
    assert checks["e1x_repair_fuse_reader_bridges_otp_to_repair_loader"]["status"] == "pass"
