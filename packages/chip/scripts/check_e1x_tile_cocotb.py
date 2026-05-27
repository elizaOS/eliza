#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_tile_cocotb.json"
RESULT_XML = ROOT / "verify/cocotb/results/e1x_tile_tb_test_e1x_tile.xml"
EXPECTED_TESTS = {
    "tile_programs_core_through_instruction_port",
    "tile_routes_fabric_wavelet_into_core_and_back_out",
    "tile_ecall_halts_integrated_core_and_blocks_wavelets",
}


def run_cocotb() -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x"
    env["COCOTB_TOPLEVEL"] = "e1x_tile_tb"
    env["COCOTB_MODULE"] = "test_e1x_tile"
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:]
    return True, "cocotb command completed"


def parse_results() -> tuple[bool, str, dict[str, int]]:
    if not RESULT_XML.is_file():
        return False, f"missing cocotb result {RESULT_XML.relative_to(ROOT)}", {}
    root = ET.fromstring(RESULT_XML.read_text(encoding="utf-8", errors="ignore"))
    cases = list(root.iter("testcase"))
    names = {case.attrib.get("name", "") for case in cases}
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    missing = sorted(EXPECTED_TESTS - names)
    counts = {
        "testcases": len(cases),
        "failures": failures,
        "errors": errors,
        "missing_expected_tests": len(missing),
    }
    if failures or errors or missing:
        return False, f"failures={failures} errors={errors} missing={','.join(missing)}", counts
    return True, f"{len(cases)} E1X tile integration cocotb tests passed", counts


def main() -> int:
    command_ok, command_detail = run_cocotb()
    results_ok, results_detail, counts = parse_results() if command_ok else (False, "not run", {})
    checks = [
        {
            "id": "e1x_tile_cocotb_command",
            "status": "pass" if command_ok else "fail",
            "detail": command_detail,
        },
        {
            "id": "e1x_tile_cocotb_results",
            "status": "pass" if results_ok else "fail",
            "detail": results_detail,
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-tile-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X tile integration cocotb verification only; not full wafer-scale RTL, full RISC-V compliance, PD, DFT, package, or silicon evidence.",
        "evidence_paths": [
            "rtl/e1x/e1x_tile.sv",
            "verify/cocotb/e1x/e1x_tile_tb.sv",
            "verify/cocotb/e1x/test_e1x_tile.py",
            "verify/cocotb/results/e1x_tile_tb_test_e1x_tile.xml",
        ],
        "checks": checks,
        "summary": {
            **counts,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X tile cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X tile cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
