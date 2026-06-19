#!/usr/bin/env python3
"""DRAM memory-controller boundary gate.

Proves that rtl/memory/dram_ctrl/e1_dram_ctrl.sv is a real AXI4 memory
controller front-end to a verified large memory model (default 2 GiB at
0x8000_0000), not the earlier 16 KiB SRAM-backed AXI-Lite aperture:

  1. Verilator --lint-only must be clean for the AXI4 package, the
     controller RTL, and the cocotb testbench.
  2. The cocotb suite verify/cocotb/memory/test_dram_memory.py must pass in
     full, including the boundary known-answer tests:
       * capacity_readback_matches_geometry        (boot-time RAM discovery)
       * burst_write_read_back_across_row_boundary  (data integrity)
       * multiple_outstanding_writes                (write-response FIFO)
       * multiple_outstanding_reads                 (AR command FIFO)
       * backpressure_honored                       (ready/valid stall)
       * boot_memtest_walking_ones_and_addr_in_addr (memtest sweep)
       * out_of_range_read_returns_decerr           (fail-closed DECERR)
       * out_of_range_write_returns_decerr          (fail-closed DECERR)

Writes build/reports/dram_controller.json (schema eliza.gate_status.v1).
PASS only when lint is clean and every required test passes; otherwise the
gate fails closed with the failing stage named in the blocker.

Out of scope (physical / silicon dependency): the LPDDR5X analog PHY and DFI
5.0 training (read/write leveling, gate training, ZQ cal, per-lane deskew at
10.67/14.4 Gbps) tracked under docs/evidence/memory/lpddr-phy-procurement.yaml.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/dram_controller.json"
COCOTB_RESULT = ROOT / "build/reports/dram_controller_cocotb_results.xml"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_memory_claim_allowed": False,
    "memory_bandwidth_claim_allowed": False,
    "lpddr_phy_claim_allowed": False,
    "silicon_capacity_claim_allowed": False,
    "uma_claim_allowed": False,
}
COCOTB_NATIVE_RESULTS = (
    ROOT / "verify/cocotb/memory/results.xml",
    ROOT / "verify/cocotb/results/e1_dram_ctrl_mem_tb_test_dram_memory.xml",
)

AXI4_PKG = "rtl/interconnect/axi4/e1_axi4_pkg.sv"
CTRL_RTL = "rtl/memory/dram_ctrl/e1_dram_ctrl.sv"
TB = "verify/cocotb/memory/e1_dram_ctrl_mem_tb.sv"
TEST = "verify/cocotb/memory/test_dram_memory.py"

REQUIRED_TESTS = (
    "capacity_readback_matches_geometry",
    "burst_write_read_back_across_row_boundary",
    "multiple_outstanding_writes",
    "multiple_outstanding_reads",
    "backpressure_honored",
    "boot_memtest_walking_ones_and_addr_in_addr",
    "out_of_range_read_returns_decerr",
    "out_of_range_write_returns_decerr",
)

# A real controller must keep the full-AXI4 burst engine, the outstanding
# command/response FIFOs, the row-hit/miss latency model, the discoverable
# capacity, and the fail-closed DECERR path.  These tokens prove the RTL did
# not regress to the AXI-Lite SRAM aperture scaffold.
REQUIRED_RTL_TOKENS = (
    "mem_capacity_bytes",
    "mem_base_addr",
    "RESP_DECERR",
    "access_latency",
    "ROW_HIT_LATENCY",
    "ROW_MISS_LATENCY",
    "Write-response (B) FIFO",
    "AR command FIFO",
    "next_addr",
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


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def verilator_bin() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    bundled = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(bundled) if bundled.is_file() else None


def write_report(status: str, blocker_id, blocker_reason, detail) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.gate_status.v1",
                "gate": "dram-controller-check",
                "status": status,
                "blocker_id": blocker_id,
                "blocker_reason": blocker_reason,
                "evidence_paths": [CTRL_RTL, AXI4_PKG, TB, TEST],
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": utc_now(),
                "subsystem": "memory",
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "linux_memory_claim_allowed": False,
                "memory_bandwidth_claim_allowed": False,
                "lpddr_phy_claim_allowed": False,
                "silicon_capacity_claim_allowed": False,
                "uma_claim_allowed": False,
                "false_claim_flags": FALSE_CLAIM_FLAGS,
                "claim_boundary": (
                    "Proves e1_dram_ctrl is a real full-AXI4 slave front-end "
                    "(read/write bursts INCR/WRAP/FIXED, AxSIZE byte addressing, "
                    "WSTRB, multiple outstanding via B/AR FIFOs, ready/valid "
                    "backpressure) to a parameterised large memory model "
                    "(default 2 GiB at 0x8000_0000, discoverable via "
                    "mem_base_addr/mem_capacity_bytes) with a DRAMsim3-LPDDR "
                    "derived row-hit/miss latency model and fail-closed DECERR "
                    "on out-of-range access, verified under Verilator + cocotb. "
                    "This is not phone-class memory evidence and not Linux "
                    "memory-sizing evidence, memory-bandwidth evidence, LPDDR "
                    "capacity, PHY, training, silicon-capacity, or UMA evidence. "
                    "Does NOT cover the LPDDR5X analog PHY / DFI 5.0 training "
                    "(physical silicon dependency in "
                    "docs/evidence/memory/lpddr-phy-procurement.yaml), on-die "
                    "ECC injection, or SoC-top integration + DTS memory node."
                ),
                "latency_model": {
                    "source": "DRAMsim3 LPDDR4_8Gb_x16_2400 timing (CK cycles)",
                    "row_hit_latency_default": 17,
                    "row_miss_latency_default": 47,
                    "write_latency_default": 14,
                    "tccd_default": 4,
                },
                "capacity": {
                    "mem_base_addr": "0x80000000",
                    "mem_capacity_bytes": "0x80000000",
                    "mem_capacity_human": "2 GiB",
                },
                "required_tests": list(REQUIRED_TESTS),
                "detail": detail,
            },
            indent=2,
        )
        + "\n"
    )


def verilator_lint() -> tuple[bool, str]:
    verilator = verilator_bin()
    if verilator is None:
        return False, "verilator not found on PATH or under external/oss-cad-suite/bin"
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        *LINT_WAIVERS,
        "--top-module",
        "e1_dram_ctrl_mem_tb",
        str(ROOT / AXI4_PKG),
        str(ROOT / CTRL_RTL),
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
            "COCOTB_MODULE": "test_dram_memory",
            "COCOTB_TOPLEVEL": "e1_dram_ctrl_mem_tb",
            "COCOTB_DIR": "verify/cocotb/memory",
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
    missing_tests = missing_required_tests_from_cocotb_outputs(out)
    failure_markers = cocotb_failure_markers(out)
    ok = proc.returncode == 0 and "FAIL=0" in out and not failure_markers and not missing_tests
    return ok, out


def cocotb_failure_markers(sim_log: str) -> list[str]:
    text = sim_log.lower()
    markers: list[str] = []
    if "fail=0" not in text:
        markers.append("missing FAIL=0 pass marker")
    if re.search(r"\bfail\s*=\s*[1-9]\d*\b", text):
        markers.append("nonzero FAIL count in cocotb log")
    if "indicates failure" in text:
        markers.append("runner reported a failing XML result")
    if re.search(r"<failure\b", text):
        markers.append("JUnit failure element present")
    if re.search(r'\bfailures\s*=\s*"[1-9]\d*"', text):
        markers.append("JUnit nonzero failures attribute present")
    for result_path in COCOTB_NATIVE_RESULTS:
        if not result_path.is_file():
            continue
        result_text = result_path.read_text(encoding="utf-8", errors="ignore").lower()
        if re.search(r"<failure\b", result_text):
            markers.append(f"{result_path.relative_to(ROOT)} contains JUnit failure element")
        if re.search(r'\bfailures\s*=\s*"[1-9]\d*"', result_text):
            markers.append(f"{result_path.relative_to(ROOT)} reports nonzero JUnit failures")
    return markers


def missing_required_tests_from_cocotb_outputs(sim_log: str) -> list[str]:
    text = sim_log
    for result_path in COCOTB_NATIVE_RESULTS:
        if result_path.is_file():
            text += "\n" + result_path.read_text(encoding="utf-8", errors="ignore")
    return [test for test in REQUIRED_TESTS if test not in text]


def write_cocotb_result(sim_log: str) -> str:
    failure_markers = cocotb_failure_markers(sim_log)
    if failure_markers:
        raise ValueError(
            "cannot write passing DRAM cocotb summary; failure markers present: "
            + ", ".join(failure_markers)
        )
    missing_tests = missing_required_tests_from_cocotb_outputs(sim_log)
    if missing_tests:
        raise ValueError(
            "cannot write passing DRAM cocotb summary; missing required tests: "
            + ", ".join(missing_tests)
        )
    COCOTB_RESULT.parent.mkdir(parents=True, exist_ok=True)
    source_log_sha256 = sha256(sim_log.encode("utf-8")).hexdigest()
    cases = "\n".join(
        f'    <testcase classname="dram_controller" name="{escape(test)}" />'
        for test in REQUIRED_TESTS
    )
    COCOTB_RESULT.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                (
                    f'<testsuite name="dram_controller" tests="{len(REQUIRED_TESTS)}" '
                    'failures="0" errors="0" skipped="0">'
                ),
                "  <properties>",
                '    <property name="artifact_kind" value="derived_cocotb_summary" />',
                ('    <property name="source_command" value="scripts/run_cocotb.sh" />'),
                (f'    <property name="source_log_sha256" value="{source_log_sha256}" />'),
                "  </properties>",
                cases,
                "</testsuite>",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return COCOTB_RESULT.relative_to(ROOT).as_posix()


def check_rtl_tokens() -> tuple[bool, list[str]]:
    text = (ROOT / CTRL_RTL).read_text()
    missing = [tok for tok in REQUIRED_RTL_TOKENS if tok not in text]
    return (not missing), missing


def check_required_tests_present() -> tuple[bool, list[str]]:
    text = (ROOT / TEST).read_text()
    missing = [t for t in REQUIRED_TESTS if f"async def {t}" not in text]
    return (not missing), missing


def main() -> int:
    for rel in (AXI4_PKG, CTRL_RTL, TB, TEST):
        if not (ROOT / rel).is_file():
            write_report("BLOCKED", "missing_source", f"missing {rel}", {})
            print(f"BLOCKED: missing {rel}")
            return 1

    tokens_ok, missing_tokens = check_rtl_tokens()
    if not tokens_ok:
        write_report(
            "BLOCKED",
            "controller_rtl_regressed",
            "RTL is missing real memory-controller tokens: " + ", ".join(missing_tokens),
            {"missing_rtl_tokens": missing_tokens},
        )
        print("BLOCKED: controller RTL tokens missing:", ", ".join(missing_tokens))
        return 1

    tests_ok, missing_tests = check_required_tests_present()
    if not tests_ok:
        write_report(
            "BLOCKED",
            "required_tests_absent",
            "cocotb suite is missing required tests: " + ", ".join(missing_tests),
            {"missing_tests": missing_tests},
        )
        print("BLOCKED: required tests missing:", ", ".join(missing_tests))
        return 1

    lint_ok, lint_log = verilator_lint()
    if not lint_ok:
        write_report(
            "BLOCKED",
            "verilator_lint_failed",
            "Verilator --lint-only reported errors on the DRAM controller RTL.",
            {"lint_log_tail": lint_log[-2000:]},
        )
        print("BLOCKED: verilator lint failed")
        print(lint_log[-2000:])
        return 1

    sim_ok, sim_log = run_cocotb()
    if not sim_ok:
        missing_sim_tests = missing_required_tests_from_cocotb_outputs(sim_log)
        write_report(
            "BLOCKED",
            "cocotb_memory_suite_failed",
            "The cocotb DRAM memory suite did not pass cleanly.",
            {"sim_log_tail": sim_log[-2000:], "missing_required_tests": missing_sim_tests},
        )
        print("BLOCKED: cocotb memory suite failed")
        print(sim_log[-2000:])
        return 1

    write_report(
        "PASS",
        None,
        None,
        {
            "verilator_lint": "clean",
            "cocotb": "FAIL=0",
            "cocotb_result": write_cocotb_result(sim_log),
            "cocotb_result_artifact_kind": "derived_cocotb_summary",
            "cocotb_source_log_sha256": sha256(sim_log.encode("utf-8")).hexdigest(),
            "required_tests": list(REQUIRED_TESTS),
        },
    )
    print("PASS: DRAM memory-controller boundary gate")
    print("  verilator --lint-only: clean")
    print(f"  cocotb {TEST}: all tests pass (FAIL=0)")
    print(f"  required tests: {len(REQUIRED_TESTS)} present and green")
    print("  capacity: 2 GiB at 0x80000000 (discoverable via mem_base_addr/mem_capacity_bytes)")
    print(f"  report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
