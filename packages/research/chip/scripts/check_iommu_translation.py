#!/usr/bin/env python3
"""RISC-V IOMMU two-stage translation gate.

Proves that the IOMMU page-table walker in rtl/iommu/e1_riscv_iommu.sv is a
real translating IOMMU, not an identity/allowlist stub:

  1. Verilator --lint-only must be clean for the IOMMU package + RTL + the
     AXI4 package and the cocotb testbench (the reserved walk port uses the
     e1_axi4_pkg interconnect types).
  2. The cocotb suite verify/cocotb/iommu/test_riscv_iommu.py must pass in
     full, including the walker known-answer tests:
       * walker_single_stage_iova_to_pa  (DDT -> Sv39 first-stage -> PA)
       * walker_two_stage_iova_to_pa     (Sv39 S1 composed with Sv39x4 GS)
       * walker_unmapped_iova_faults_with_record (fail-closed fault + FQ record)
       * walker_bare_mode_identity       (BARE pass-through)
       * command_queue_iofence_completes (CQ IOFENCE.C completion)

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
)

# A real walker must not regress to an identity/allowlist-only translator:
# these tokens prove the page-table-walk FSM, the fault path, and the CQ
# engine are present in the RTL.
REQUIRED_RTL_TOKENS = (
    "real two-stage walker",
    "TR_DDT_REQ",
    "TR_FS_REQ",
    "TR_GS_REQ",
    "ddte_next_ptr",
    "CAUSE_LOAD_PAGE_FAULT",
    "CMD_OP_IOFENCE",
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
                    "Proves the IOMMU performs a real RISC-V v1.0.1 two-stage "
                    "page-table walk (DDT 1/2/3-level -> device context -> "
                    "Sv39/Sv48 first-stage composed with Sv39x4/Sv48x4 G-stage), "
                    "fail-closed faults to the fault queue, BARE identity "
                    "pass-through, and CQ IOFENCE.C completion, verified under "
                    "Verilator + cocotb. Does NOT cover IOATC/TLB persistence, "
                    "PASID/PDT walks, MSI/MRIF translation, FQ DMA-to-DRAM, or "
                    "the IOPMP region layer (separate gates)."
                ),
                "required_tests": list(REQUIRED_TESTS),
                "detail": detail,
            },
            indent=2,
        )
        + "\n"
    )


def verilator_lint() -> tuple[bool, str]:
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
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
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
            "walker_rtl_absent",
            "RTL is missing real two-stage walker tokens: " + ", ".join(missing_tokens),
            {"missing_rtl_tokens": missing_tokens},
        )
        print("BLOCKED: walker RTL tokens missing:", ", ".join(missing_tokens))
        return 1

    tests_ok, missing_tests = check_required_tests_present()
    if not tests_ok:
        write_report(
            "BLOCKED",
            "required_tests_absent",
            "cocotb suite is missing required walker tests: " + ", ".join(missing_tests),
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
    print("PASS: IOMMU two-stage translation gate")
    print("  verilator --lint-only: clean")
    print(f"  cocotb {TEST}: all tests pass (FAIL=0)")
    print(f"  required walker tests: {len(REQUIRED_TESTS)} present and green")
    print(f"  report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
