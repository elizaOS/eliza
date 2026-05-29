#!/usr/bin/env python3
"""Descriptor scatter-gather DMA engine gate.

Proves that rtl/dma/e1_dma_sg.sv is a real descriptor-based, full-AXI4
scatter-gather DMA -- not the AXI-Lite word-copy scaffold in rtl/dma/e1_dma.sv:

  1. verilator --lint-only must be clean for the AXI4 package + the SG DMA RTL.
  2. The cocotb suite verify/cocotb/dma_sg/test_dma_sg.py must pass in full,
     including the known-answer tests:
       * sg_multi_descriptor_copy_is_byte_exact  (memory-resident descriptor
         ring fetched + executed; multi-descriptor scatter-gather byte-exact)
       * sg_unaligned_head_and_tail_is_exact     (sub-word src/dst offsets,
         non-word length; neighbour bytes untouched)
       * sg_long_transfer_spans_many_bursts      (4 KiB across many INCR bursts)
       * sg_axcache_attribute_drives_bus         (cacheable/device AXCACHE hook)
       * sg_decerr_sets_error_status_and_irq_without_corrupting_siblings
         (AXI DECERR -> descriptor error status + error IRQ, chain halts
         fail-closed, sibling descriptor destination untouched)

Writes build/reports/dma_engine.json (schema eliza.gate_status.v1).  PASS only
when lint is clean and every required test passes; otherwise the gate fails
closed with the failing stage named in the blocker.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/dma_engine.json"

AXI4_PKG = "rtl/interconnect/axi4/e1_axi4_pkg.sv"
DMA_RTL = "rtl/dma/e1_dma_sg.sv"
TEST = "verify/cocotb/dma_sg/test_dma_sg.py"

REQUIRED_TESTS = (
    "sg_multi_descriptor_copy_is_byte_exact",
    "sg_unaligned_head_and_tail_is_exact",
    "sg_long_transfer_spans_many_bursts",
    "sg_axcache_attribute_drives_bus",
    "sg_decerr_sets_error_status_and_irq_without_corrupting_siblings",
)

# A real descriptor SG engine must not regress to a word-copy AXI-Lite mover:
# these tokens prove the descriptor fetch FSM, full AXI4 burst data mover,
# completion writeback + IRQ, and fail-closed error path are present.
REQUIRED_RTL_TOKENS = (
    "module e1_dma_sg",
    "S_DFETCH_AR",  # memory-resident descriptor fetch over AXI4
    "DESC_NEXT",  # next-descriptor chain link
    "m_arlen",  # full AXI4 burst (not AXI-Lite)
    "m_awlen",
    "BURST_INCR",
    "m_wstrb",  # byte-granular unaligned head/tail
    "S_ERROR",  # fail-closed error path
    "RESP_OKAY",
    "FLAG_IRQ_BIT",  # completion interrupt
)

LINT_WAIVERS = [
    "-Wno-UNUSEDSIGNAL",
    "-Wno-UNUSEDPARAM",
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
                "gate": "dma-engine-check",
                "status": status,
                "blocker_id": blocker_id,
                "blocker_reason": blocker_reason,
                "evidence_paths": [DMA_RTL, AXI4_PKG, TEST],
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": utc_now(),
                "subsystem": "dma",
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "production_memory_system_claim_allowed": False,
                "coherent_dma_claim_allowed": False,
                "linux_dmaengine_driver_claim_allowed": False,
                "throughput_claim_allowed": False,
                "claim_boundary": (
                    "Proves e1_dma_sg is a descriptor-based scatter-gather DMA "
                    "with a full AXI4 INCR-burst read+write data mover: it "
                    "fetches a memory-resident descriptor ring (src/dst/len/"
                    "flags/next) over AXI4, executes byte-exact copies with "
                    "unaligned head/tail handling and byte strobes, writes a "
                    "completion status word back into each descriptor, raises a "
                    "completion interrupt, walks the chain, drives the "
                    "programmed AXCACHE attribute, and fails closed on AXI "
                    "SLVERR/DECERR (descriptor error status + error IRQ, chain "
                    "halts, no silent partial). Verified under Verilator + "
                    "cocotb against a randomized-backpressure AXI4 slave. Does "
                    "NOT cover SoC-fabric wiring (the source-ID tag for IOMMU/"
                    "IOPMP), multi-channel arbitration, >16-beat AxLEN, the "
                    "Linux dmaengine driver, or silicon signoff (separate "
                    "gates / follow-ons)."
                ),
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
        "e1_dma_sg",
        str(ROOT / AXI4_PKG),
        str(ROOT / DMA_RTL),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    ok = proc.returncode == 0 and "%Error" not in proc.stderr and "%Warning" not in proc.stderr
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
            "COCOTB_MODULE": "test_dma_sg",
            "COCOTB_TOPLEVEL": "e1_dma_sg",
            "COCOTB_DIR": "verify/cocotb/dma_sg",
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
    text = (ROOT / DMA_RTL).read_text()
    missing = [tok for tok in REQUIRED_RTL_TOKENS if tok not in text]
    return (not missing), missing


def check_required_tests_present() -> tuple[bool, list[str]]:
    text = (ROOT / TEST).read_text()
    missing = [t for t in REQUIRED_TESTS if f"async def {t}" not in text]
    return (not missing), missing


def main() -> int:
    for rel in (AXI4_PKG, DMA_RTL, TEST):
        if not (ROOT / rel).is_file():
            write_report("BLOCKED", "missing_source", f"missing {rel}", {})
            print(f"BLOCKED: missing {rel}")
            return 1

    tokens_ok, missing_tokens = check_rtl_tokens()
    if not tokens_ok:
        write_report(
            "BLOCKED",
            "sg_dma_rtl_absent",
            "RTL is missing real descriptor-SG/AXI4-burst tokens: " + ", ".join(missing_tokens),
            {"missing_rtl_tokens": missing_tokens},
        )
        print("BLOCKED: SG DMA RTL tokens missing:", ", ".join(missing_tokens))
        return 1

    tests_ok, missing_tests = check_required_tests_present()
    if not tests_ok:
        write_report(
            "BLOCKED",
            "required_tests_absent",
            "cocotb suite is missing required SG tests: " + ", ".join(missing_tests),
            {"missing_tests": missing_tests},
        )
        print("BLOCKED: required tests missing:", ", ".join(missing_tests))
        return 1

    lint_ok, lint_log = verilator_lint()
    if not lint_ok:
        write_report(
            "BLOCKED",
            "verilator_lint_failed",
            "Verilator --lint-only reported errors/warnings on the SG DMA RTL.",
            {"lint_log_tail": lint_log[-2000:]},
        )
        print("BLOCKED: verilator lint failed")
        print(lint_log[-2000:])
        return 1

    sim_ok, sim_log = run_cocotb()
    if not sim_ok:
        write_report(
            "BLOCKED",
            "cocotb_dma_sg_suite_failed",
            "The cocotb scatter-gather DMA suite did not pass cleanly.",
            {"sim_log_tail": sim_log[-2000:]},
        )
        print("BLOCKED: cocotb SG DMA suite failed")
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
    print("PASS: descriptor scatter-gather DMA engine gate")
    print("  verilator --lint-only: clean")
    print(f"  cocotb {TEST}: all tests pass (FAIL=0)")
    print(f"  required SG tests: {len(REQUIRED_TESTS)} present and green")
    print(f"  report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
