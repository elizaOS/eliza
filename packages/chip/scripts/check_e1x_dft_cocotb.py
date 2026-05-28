#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_dft_cocotb.json"
RESULT_DIR = ROOT / "verify/cocotb/results"

RUNS = {
    "sram_ecc": {
        "top": "e1x_sram_ecc_tb",
        "module": "test_e1x_sram_ecc",
        "expected": {
            "ecc_round_trips_clean_words",
            "ecc_corrects_every_single_bit_flip",
            "ecc_detects_double_bit_flips_without_miscorrection",
            "ecc_status_counters_track_events",
        },
    },
    "mbist": {
        "top": "e1x_mbist_tb",
        "module": "test_e1x_mbist",
        "expected": {
            "mbist_passes_clean_memory",
            "mbist_detects_stuck_at_one",
            "mbist_detects_stuck_at_zero",
        },
    },
}


def run_cocotb(top: str, module: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x_dft"
    env["COCOTB_TOPLEVEL"] = top
    env["COCOTB_MODULE"] = module
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


def parse_results(result_xml: Path, expected_tests: set[str]) -> tuple[bool, str, dict[str, int]]:
    if not result_xml.is_file():
        return False, f"missing cocotb result {result_xml.relative_to(ROOT)}", {}
    root = ET.fromstring(result_xml.read_text(encoding="utf-8", errors="ignore"))
    cases = list(root.iter("testcase"))
    names = {case.attrib.get("name", "") for case in cases}
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    missing = sorted(expected_tests - names)
    counts = {
        "testcases": len(cases),
        "failures": failures,
        "errors": errors,
        "missing_expected_tests": len(missing),
    }
    if failures or errors or missing:
        return False, f"failures={failures} errors={errors} missing={','.join(missing)}", counts
    return True, f"{len(cases)} E1X DFT cocotb tests passed", counts


def main() -> int:
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        top = str(run["top"])
        module = str(run["module"])
        expected = run["expected"]
        if not isinstance(expected, set):
            raise TypeError("invalid E1X DFT cocotb run table")
        command_ok, command_detail = run_cocotb(top, module)
        result_path = RESULT_DIR / f"{top}_{module}.xml"
        results_ok, results_detail, counts = (
            parse_results(result_path, expected) if command_ok else (False, "not run", {})
        )
        for key in aggregate_counts:
            aggregate_counts[key] += int(counts.get(key, 0))
        checks.extend(
            [
                {
                    "id": f"e1x_{run_id}_cocotb_command",
                    "status": "pass" if command_ok else "fail",
                    "detail": command_detail,
                },
                {
                    "id": f"e1x_{run_id}_cocotb_results",
                    "status": "pass" if results_ok else "fail",
                    "detail": results_detail,
                },
            ]
        )
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-dft-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X SECDED ECC codec and March C- MBIST controller cocotb verification only; "
            "not scan-chain stitching, ATPG coverage, foundry SRAM macro behavior, at-speed "
            "test, full-wafer fault coverage, or silicon defect evidence. Those are "
            "fail-closed external dependencies per docs/arch/e1x-dft.md."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_sram_ecc.sv",
            "rtl/e1x/e1x_mbist.sv",
            "docs/arch/e1x-dft.md",
            "verify/cocotb/e1x_dft/e1x_sram_ecc_tb.sv",
            "verify/cocotb/e1x_dft/e1x_mbist_tb.sv",
            "verify/cocotb/e1x_dft/test_e1x_sram_ecc.py",
            "verify/cocotb/e1x_dft/test_e1x_mbist.py",
            "verify/cocotb/results/e1x_sram_ecc_tb_test_e1x_sram_ecc.xml",
            "verify/cocotb/results/e1x_mbist_tb_test_e1x_mbist.xml",
        ],
        "checks": checks,
        "summary": {
            **aggregate_counts,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X DFT cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X DFT cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
