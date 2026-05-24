#!/usr/bin/env python3
"""RISC-V IOMMU local translation-subset gate.

Proves the local RTL subset in rtl/iommu/e1_riscv_iommu.sv: register/fault
surface, minimal DDT + Sv39 first-stage read walk under identity G-stage,
fail-closed unmapped faults, BARE identity mode, and IOFENCE.C CQ fetch/decode.
It intentionally does not claim full phone/Linux IOMMU completion:

  1. Verilator --lint-only must be clean for the IOMMU package + RTL + the
     AXI4 package and the cocotb testbench (the reserved walk port uses the
     e1_axi4_pkg interconnect types).
  2. The cocotb suite verify/cocotb/iommu/test_riscv_iommu.py must pass in
     full, including the walker known-answer tests:
       * walker_single_stage_iova_to_pa  (DDT -> Sv39 first-stage -> PA)
       * walker_two_stage_iova_to_pa     (Sv39 S1 under identity G-stage)
       * walker_unmapped_iova_faults_with_record (fail-closed fault + FQ record)
       * walker_bare_mode_identity       (BARE pass-through)
       * command_queue_iofence_completes (CQ IOFENCE.C fetch/decode/completion)
       * command_queue_invalid_opcode_stops_without_advancing (CQ fail-closed)

Writes build/reports/iommu_translation.json (schema eliza.gate_status.v1).
PASS only when lint is clean and every required test passes; otherwise the
gate fails closed with the failing stage named in the blocker.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/iommu_translation.json"
OSS_CAD_BIN = ROOT / "external/oss-cad-suite/bin"

AXI4_PKG = "rtl/interconnect/axi4/e1_axi4_pkg.sv"
IOMMU_PKG = "rtl/iommu/e1_riscv_iommu_pkg.sv"
IOMMU_RTL = "rtl/iommu/e1_riscv_iommu.sv"
TB = "verify/cocotb/iommu/e1_iommu_tb.sv"
TEST = "verify/cocotb/iommu/test_riscv_iommu.py"

REQUIRED_TESTS = (
    "walker_single_stage_iova_to_pa",
    "walker_two_stage_iova_to_pa",
    "walker_unmapped_iova_faults_with_record",
    "walker_bare_mode_identity",
    "command_queue_iofence_completes",
    "command_queue_invalid_opcode_stops_without_advancing",
)

# These tokens prove the local translation subset did not regress back to
# identity/allowlist-only behavior.
REQUIRED_RTL_TOKENS = (
    "WALK_DC0_REQ",
    "WALK_PT_REQ",
    "WALK_DATA_REQ",
    "walk_iohgatp",
    "CMD_OP_IOFENCE_C",
    "CMD_FETCH_REQ",
    "CMD_FETCH_RSP",
    "reg_cqcsr[8]",
    "cmd_complete_irq",
)

LINT_WAIVERS = [
    "-Wno-UNUSEDSIGNAL",
    "-Wno-UNUSEDPARAM",
    "-Wno-WIDTHEXPAND",
    "-Wno-WIDTHTRUNC",
    "-Wno-IMPLICITSTATIC",
    "-Wno-CASEINCOMPLETE",
    "-Wno-UNOPTFLAT",
    "-Wno-DECLFILENAME",
]


def write_report(status: str, blocker_id, blocker_reason, detail) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.gate_status.v1",
                "gate": "iommu-translation-check",
                "status": status,
                "blocker_id": blocker_id,
                "blocker_reason": blocker_reason,
                "evidence_paths": [IOMMU_RTL, IOMMU_PKG, AXI4_PKG, TB, TEST],
                "as_of": datetime.now(UTC).isoformat(),
                "subsystem": "security",
                "claim_boundary": (
                    "Proves the local IOMMU subset performs DDT + Sv39 "
                    "first-stage reads under identity G-stage, fail-closed "
                    "unmapped faults, BARE identity pass-through, and CQ "
                    "IOFENCE.C fetch/decode/completion with invalid-opcode "
                    "fail-closed behavior, verified under Verilator + cocotb. "
                    "Does NOT cover non-identity G-stage walks, Sv48/Sv57, "
                    "IOATC/TLB persistence, PASID/PDT walks, ATS/PRI/MSI/MRIF "
                    "transactions, FQ DMA-to-DRAM, Linux attach, or IOPMP."
                ),
                "required_tests": list(REQUIRED_TESTS),
                "detail": detail,
            },
            indent=2,
        )
        + "\n"
    )


def verilator_lint() -> tuple[bool, str]:
    env = dict(os.environ)
    if OSS_CAD_BIN.is_dir():
        env["PATH"] = f"{OSS_CAD_BIN}{os.pathsep}{env.get('PATH', '')}"
    binary = "verilator"
    cmd = [
        binary,
        "--lint-only",
        "-Wall",
        *LINT_WAIVERS,
        "--top-module",
        "e1_iommu_tb",
        str(ROOT / AXI4_PKG),
        str(ROOT / IOMMU_PKG),
        str(ROOT / IOMMU_RTL),
        str(ROOT / TB),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, env=env)
    ok = proc.returncode == 0 and "%Error" not in proc.stderr
    return ok, (proc.stderr or proc.stdout).strip()


def run_cocotb() -> tuple[bool, str]:
    python = os.environ.get("COCOTB_PYTHON")
    if not python:
        venv = ROOT / ".venv/bin/python"
        python = str(venv) if venv.exists() else sys.executable
    env = dict(os.environ)
    env.update(
        {
            "PYTHON": python,
            "COCOTB_MODULE": "test_riscv_iommu",
            "COCOTB_TOPLEVEL": "e1_iommu_tb",
            "COCOTB_DIR": "verify/cocotb/iommu",
        }
    )
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
    )
    out = proc.stdout + proc.stderr
    ok = proc.returncode == 0 and "FAIL=0" in out and "indicates failure" not in out
    return ok, out


def check_rtl_tokens() -> tuple[bool, list[str]]:
    text = (ROOT / IOMMU_RTL).read_text()
    missing = [tok for tok in REQUIRED_RTL_TOKENS if tok not in text]
    return (not missing), missing


def check_required_tests_present() -> tuple[bool, list[str]]:
    text = (ROOT / TEST).read_text()
    missing = [t for t in REQUIRED_TESTS if f"async def {t}" not in text]
    return (not missing), missing


def main() -> int:
    for rel in (AXI4_PKG, IOMMU_PKG, IOMMU_RTL, TB, TEST):
        if not (ROOT / rel).is_file():
            write_report("BLOCKED", "missing_source", f"missing {rel}", {})
            print(f"BLOCKED: missing {rel}")
            return 1

    tokens_ok, missing_tokens = check_rtl_tokens()
    if not tokens_ok:
        write_report(
            "BLOCKED",
            "translation_subset_rtl_absent",
            "RTL is missing local translation-subset tokens: " + ", ".join(missing_tokens),
            {"missing_rtl_tokens": missing_tokens},
        )
        print("BLOCKED: local translation-subset RTL tokens missing:", ", ".join(missing_tokens))
        return 1

    tests_ok, missing_tests = check_required_tests_present()
    if not tests_ok:
        write_report(
            "BLOCKED",
            "required_tests_absent",
            "cocotb suite is missing required translation-subset tests: " + ", ".join(missing_tests),
            {"missing_tests": missing_tests},
        )
        print("BLOCKED: required tests missing:", ", ".join(missing_tests))
        return 1

    lint_ok, lint_log = verilator_lint()
    if not lint_ok:
        write_report(
            "BLOCKED",
            "verilator_lint_failed",
            "Verilator --lint-only reported errors on the IOMMU RTL.",
            {"lint_log_tail": lint_log[-2000:]},
        )
        print("BLOCKED: verilator lint failed")
        print(lint_log[-2000:])
        return 1

    sim_ok, sim_log = run_cocotb()
    if not sim_ok:
        write_report(
            "BLOCKED",
            "cocotb_translation_suite_failed",
            "The cocotb IOMMU translation suite did not pass cleanly.",
            {"sim_log_tail": sim_log[-2000:]},
        )
        print("BLOCKED: cocotb translation suite failed")
        print(sim_log[-2000:])
        return 1

    write_report(
        "PASS",
        None,
        None,
        {
            "verilator_lint": "clean",
            "cocotb": "FAIL=0",
            "required_tests": list(REQUIRED_TESTS),
        },
    )
    print("PASS: IOMMU local translation-subset gate")
    print("  verilator --lint-only: clean")
    print(f"  cocotb {TEST}: all tests pass (FAIL=0)")
    print(f"  required local subset tests: {len(REQUIRED_TESTS)} present and green")
    print(f"  report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
