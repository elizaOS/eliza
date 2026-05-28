#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_pe_core_cocotb.json"
MICROKERNEL_PROOF_JSON = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"

RUNS = {
    "pe_core": {
        "top": "e1x_pe_core_tb",
        "module": "test_e1x_pe_core",
        "result": ROOT / "verify/cocotb/results/e1x_pe_core_tb_test_e1x_pe_core.xml",
        "expected": {
            "integer_arithmetic_and_immediates",
            "shifts_and_set_less_than",
            "word_operations_sign_extend",
            "branches_taken_and_not_taken",
            "jal_jalr_control_flow",
            "loads_stores_roundtrip",
            "mul_div_rem_correctness",
            "div_by_zero_and_overflow",
            "word_mul_div",
            "lui_auipc",
            "csr_mcycle_minstret_mscratch",
            "fence_is_ordering_nop",
            "ecall_halts",
            "ebreak_halts",
            "wavelet_mmio_rx_tx",
            "generated_w4a8_microkernel_dot_runs_on_pe_core",
        },
    },
}


def ensure_microkernel_proof() -> None:
    subprocess.run(
        [sys.executable, "scripts/check_e1x_kernel_codegen.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    )


def run_cocotb(top: str, module: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x_core_full"
    env["COCOTB_TOPLEVEL"] = top
    env["COCOTB_MODULE"] = module
    env["E1X_W4A8_MICROKERNEL_PROOF_JSON"] = str(MICROKERNEL_PROOF_JSON)
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
    return True, f"{len(cases)} E1X PE-core cocotb tests passed", counts


def main() -> int:
    ensure_microkernel_proof()
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        command_ok, command_detail = run_cocotb(str(run["top"]), str(run["module"]))
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid E1X PE-core cocotb run table")
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
        "gate": "e1x-pe-core-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X processing-element core (RV64IM_Zicsr_Zifencei integer datapath) cocotb "
            "verification with assembled programs, including an RTL-executed generated W4A8 "
            "dot-product sample from the real-graph microkernel proof. Floating point "
            "(RV F/D) is deliberately out of scope for the INT8/W4A8 inference PE. Not "
            "full RISC-V compliance, PD, DFT, package, or silicon evidence."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_pe_core.sv",
            "verify/cocotb/e1x_core_full/e1x_pe_core_tb.sv",
            "verify/cocotb/e1x_core_full/test_e1x_pe_core.py",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "verify/cocotb/results/e1x_pe_core_tb_test_e1x_pe_core.xml",
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
        print("BLOCKED: E1X PE-core cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X PE-core cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
