#!/usr/bin/env python3
"""interrupt-controller-rtl-check gate.

Fail-closed gate for the E1 RISC-V interrupt fabric: the production CLINT
(rtl/interrupts/e1_clint.sv) and PLIC (rtl/interrupts/e1_plic.sv). These are the
timer/software (CLINT -> mip.MTIP/MSIP) and external (PLIC -> mip.MEIP/SEIP)
interrupt controllers that Linux/AOSP require to boot, replacing the previously
scaffolded CLINT/PLIC-lite wiring flagged in the chip-os boot-gap survey.

Writes build/reports/interrupt_controller.json in the eliza.gate_status.v1
shape. PASS requires ALL of:
  (a) e1_clint and e1_plic each lint clean under `verilator --lint-only -Wall`
      (strict, no functional waivers);
  (b) the CLINT cocotb suite (verify/cocotb/test_clint_timer_irq.py) runs and
      every expected test passes -- mtime monotonic, MTIP fires at the
      programmed mtimecmp and clears on rewrite, MSIP set/clear, per-hart
      isolation;
  (c) the PLIC cocotb suite (verify/cocotb/test_plic_claim_threshold.py) runs
      and every expected test passes -- highest-priority claim, threshold
      masking, disabled-source masking, and two-context isolation.

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
"""

from __future__ import annotations

import datetime as _dt
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/interrupt_controller.json"

CLINT_RTL = "rtl/interrupts/e1_clint.sv"
PLIC_RTL = "rtl/interrupts/e1_plic.sv"
COCOTB_DIR = ROOT / "verify/cocotb"

CLINT_MAKEFILE = "Makefile.clint"
CLINT_RESULTS = COCOTB_DIR / "results_clint.xml"
CLINT_SIM_BUILD = "sim_build_clint"
CLINT_EXPECTED = (
    "clint_mtime_monotonic",
    "clint_timer_irq_fires_when_mtime_ge_mtimecmp",
    "clint_msip_software_interrupt",
    "clint_per_hart_isolation",
)

PLIC_MAKEFILE = "Makefile.plic"
PLIC_RESULTS = COCOTB_DIR / "results_plic.xml"
PLIC_SIM_BUILD = "sim_build_plic"
PLIC_EXPECTED = (
    "plic_claim_returns_highest_priority",
    "plic_threshold_masks_below",
    "plic_disabled_source_never_fires",
    "plic_two_context_isolation",
)

FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
    "soc_mip_wiring_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_lint(verilator: str, rtl: str, top: str, check_id: str) -> dict:
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / rtl),
        "--top-module",
        top,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": check_id,
            "status": "pass",
            "detail": f"{top} lints clean under verilator --lint-only -Wall "
            "(no functional waivers)",
        }
    return {"id": check_id, "status": "fail", "detail": "lint failed: " + "\n".join(diags[:8])}


def check_cocotb(
    makefile: str, results: Path, sim_build: str, expected: tuple[str, ...], check_id: str
) -> dict:
    if results.exists():
        results.unlink()
    proc = subprocess.run(
        [
            "make",
            "-C",
            str(COCOTB_DIR),
            "-f",
            makefile,
            f"SIM_BUILD={sim_build}",
            f"COCOTB_RESULTS_FILE={results.name}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if not results.is_file():
        last = proc.stderr.splitlines()[-1] if proc.stderr else ""
        return {
            "id": check_id,
            "status": "blocked",
            "detail": f"no {results.name}; cocotb/verilator unavailable. {last}",
        }
    tree = ET.parse(results)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in expected if t not in seen]
    if failed or missing:
        return {"id": check_id, "status": "fail", "detail": f"failed={failed} missing={missing}"}
    return {
        "id": check_id,
        "status": "pass",
        "detail": f"{len(expected)} cocotb tests passed",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    verilator = _verilator()
    if verilator is None:
        for cid in ("clint_lint", "plic_lint", "clint_cocotb", "plic_cocotb"):
            checks.append(
                {
                    "id": cid,
                    "status": "blocked",
                    "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
                }
            )
    else:
        checks.append(check_lint(verilator, CLINT_RTL, "e1_clint", "clint_lint"))
        checks.append(check_lint(verilator, PLIC_RTL, "e1_plic", "plic_lint"))
        checks.append(
            check_cocotb(
                CLINT_MAKEFILE, CLINT_RESULTS, CLINT_SIM_BUILD, CLINT_EXPECTED, "clint_cocotb"
            )
        )
        checks.append(
            check_cocotb(PLIC_MAKEFILE, PLIC_RESULTS, PLIC_SIM_BUILD, PLIC_EXPECTED, "plic_cocotb")
        )

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "interrupt_controller_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "interrupt_controller_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "interrupt-controller-rtl-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        **FALSE_CLAIM_FLAGS,
        "evidence_paths": [
            CLINT_RTL,
            PLIC_RTL,
            "verify/cocotb/test_clint_timer_irq.py",
            "verify/cocotb/test_plic_claim_threshold.py",
            "verify/cocotb/Makefile.clint",
            "verify/cocotb/Makefile.plic",
            "scripts/check_interrupt_controller.py",
        ],
        "as_of": _now(),
        "subsystem": "interrupts",
        "claim_boundary": (
            "The E1 CLINT (rtl/interrupts/e1_clint.sv) implements the "
            "SiFive/RISC-V riscv,clint0 memory map: per-hart msip (mip.MSIP), "
            "per-hart 64-bit mtimecmp and a free-running 64-bit mtime that drive "
            "mip.MTIP (mtip_o = mtime >= mtimecmp). The E1 PLIC "
            "(rtl/interrupts/e1_plic.sv) implements the RISC-V riscv,plic0 / "
            "sifive,plic-1.0.0 map: per-source priority, per-context enables and "
            "threshold, and claim/complete arbitration returning the "
            "highest-priority enabled pending source above threshold "
            "(mip.MEIP/SEIP per context). Both are 32-bit AXI-Lite slaves. This "
            "gate proves the RTL lints clean (-Wall, no functional waivers) and "
            "the cocotb timer/IRQ contracts pass (timer fires at the programmed "
            "mtimecmp; claim returns the highest-priority source above "
            "threshold; threshold/disable masking; two-context isolation). It "
            "does NOT prove the CLINT/PLIC -> CPU mip wiring inside the "
            "contended SoC top (rtl/top/e1_soc_top.sv), which currently "
            "instantiates the bring-up scaffold (rtl/peripherals/e1_clint.sv) "
            "and a PLIC-lite -- swapping in these modules at the SoC boundary is "
            "a SoC-integration follow-on."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} interrupt-controller-rtl-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
