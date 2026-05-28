#!/usr/bin/env python3
"""soc-real-integration-check gate.

Fail-closed gate proving the production interrupt + main-memory leaves compose
into e1_soc_top behind +define+E1_SOC_REAL_IRQ +define+E1_SOC_REAL_DRAM:

  * the real RISC-V CLINT (rtl/interrupts/e1_clint.sv) @ 0x0200_0000 drives
    mip.MSIP / mip.MTIP,
  * the real RISC-V PLIC (rtl/interrupts/e1_plic.sv) @ 0x0C00_0000 round-trips
    a device external interrupt via claim/complete to mip.MEIP,
  * the real full-AXI4 DRAM controller (rtl/memory/dram_ctrl/e1_dram_ctrl.sv)
    backs the 2 GiB @ 0x8000_0000 main-memory window,

all wired through rtl/top/adapters/e1_soc_real_subsys.sv and the additive,
define-guarded composition in rtl/top/e1_soc_top.sv. The legacy bring-up path
(no defines) is preserved.

NOTE on naming: scripts/check_soc_integration.py already exists and owns the
parallel e1_soc_integrated cross-domain top; this gate covers the distinct
e1_soc_top real-IRQ/real-DRAM composition and writes its own report.

PASS requires ALL of:
  (a) the integrated config (e1_soc_top + the real leaves + the adapter) lints
      clean under `verilator --lint-only -Wall` with +define+E1_SOC_REAL_IRQ
      +define+E1_SOC_REAL_DRAM (SoC-block style waivers only);
  (b) the integration smoke (verify/cocotb/soc/test_e1_soc_integrated_smoke.py)
      runs and every test passes: DRAM word read/write through the real AXI4
      controller (with discoverable 2 GiB capacity), a real-CLINT timer
      interrupt taken (mtip_o), and a real-PLIC external-IRQ claim/complete
      round-trip (meip_o).

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/soc_integration.json"

COCOTB_DIR = ROOT / "verify/cocotb/soc"

# Integrated-config source list (mirrors verify/cocotb/soc/Makefile). The
# bring-up CLINT (rtl/peripherals/e1_clint.sv) is intentionally excluded: in
# this config e1_soc_top instantiates the real rtl/interrupts/e1_clint.sv (same
# module name), so including both would be a duplicate-module declaration.
INTEGRATED_SOURCES = [
    "rtl/interconnect/axi4/e1_axi4_pkg.sv",
    "rtl/top/e1_soc_pkg.sv",
    "rtl/peripherals/e1_mmio_decode.sv",
    "rtl/memory/e1_behavioral_dram.sv",
    "rtl/clock/e1_reset_sync.sv",
    "rtl/bootrom/e1_bootrom.sv",
    "rtl/peripherals/e1_peripherals.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/display/e1_display.sv",
    "rtl/cpu/e1_cva6_wrapper.sv",
    "rtl/cpu/e1_cpu_axi_bridge.sv",
    "rtl/cpu/e1_tiny_cpu_contract.sv",
    "rtl/cpu/e1_cpu_subsystem_stub.sv",
    "rtl/memory/e1_weight_buffer_sram.sv",
    "rtl/interrupts/e1_clint.sv",
    "rtl/interrupts/e1_plic.sv",
    "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
    "rtl/security/rot/e1_rot_reset_seq.sv",
    "rtl/top/adapters/e1_soc_real_subsys.sv",
    "rtl/top/e1_soc_top.sv",
]

DEFINES = [
    "+define+E1_SOC_REAL_IRQ",
    "+define+E1_SOC_REAL_DRAM",
    "+define+E1_SOC_ROT_GATED",
]

# SoC-block lint waivers (mirrors verify/cocotb/soc/Makefile). Style-only
# waivers for the modeled-array / wide-mux RTL; no functional check suppressed.
LINT_WAIVERS = [
    "-Wno-UNUSEDSIGNAL",
    "-Wno-UNUSEDPARAM",
    "-Wno-WIDTHEXPAND",
    "-Wno-WIDTHTRUNC",
    "-Wno-DECLFILENAME",
    "-Wno-VARHIDDEN",
    "-Wno-IMPLICITSTATIC",
    "-Wno-CASEINCOMPLETE",
    "-Wno-UNOPTFLAT",
]

SMOKE = {
    "id": "cocotb_soc_real_integration_smoke",
    "toplevel": "e1_soc_top",
    "module": "test_e1_soc_integrated_smoke",
    "sim_build": "sim_build_soc_integration",
    "results": "results_soc_integration.xml",
    "expected": (
        "dram_rw",
        "clint_timer_irq",
        "plic_claim_complete",
        "rot_gated_boot",
    ),
    "label": "real CLINT timer IRQ + real PLIC claim/complete + real AXI4 "
    "DRAM r/w composed in e1_soc_top",
}


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _python() -> str:
    venv = ROOT / ".venv/bin/python3"
    return str(venv) if venv.is_file() else sys.executable


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_lint(verilator: str) -> dict:
    cmd = (
        [verilator, "--lint-only", "-Wall"]
        + LINT_WAIVERS
        + DEFINES
        + [str(ROOT / s) for s in INTEGRATED_SOURCES]
        + ["--top-module", "e1_soc_top"]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_elaborate_integrated",
            "status": "pass",
            "detail": "integrated e1_soc_top (E1_SOC_REAL_IRQ + E1_SOC_REAL_DRAM) "
            "+ real CLINT/PLIC/DRAM + e1_soc_real_subsys lint clean under "
            "verilator --lint-only -Wall (SoC-block style waivers only)",
        }
    return {
        "id": "verilator_elaborate_integrated",
        "status": "fail",
        "detail": "integrated elaboration failed: " + "\n".join(diags[:8]),
    }


def run_cocotb(verilator: str) -> dict:
    results = ROOT / "verify/cocotb/results" / f"{SMOKE['toplevel']}_{SMOKE['module']}.xml"
    if results.exists():
        results.unlink()
    env_python = _python()
    env = dict(os.environ)
    verilator_bin = Path(verilator).parent
    env["PATH"] = f"{verilator_bin}:{env.get('PATH', '')}"
    env.update(
        {
            "PYTHON": env_python,
            "COCOTB_TOPLEVEL": str(SMOKE["toplevel"]),
            "COCOTB_MODULE": str(SMOKE["module"]),
            "COCOTB_DIR": "verify/cocotb/soc",
        }
    )
    rc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
    )
    if not results.is_file():
        last = rc.stderr.splitlines()[-1] if rc.stderr else ""
        return {
            "id": SMOKE["id"],
            "status": "blocked",
            "detail": f"no {results.relative_to(ROOT)}; cocotb/verilator unavailable. {last}",
        }
    tree = ET.parse(results)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in SMOKE["expected"] if t not in seen]
    if failed or missing:
        return {
            "id": SMOKE["id"],
            "status": "fail",
            "detail": f"{SMOKE['label']}: failed={failed} missing={missing}",
        }
    return {
        "id": SMOKE["id"],
        "status": "pass",
        "detail": f"{len(SMOKE['expected'])} tests passed -- {SMOKE['label']}",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_elaborate_integrated",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append({"id": SMOKE["id"], "status": "blocked", "detail": "verilator not found"})
    else:
        checks.append(check_lint(verilator))
        checks.append(run_cocotb(verilator))

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "soc_integration_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "soc_integration_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "soc-real-integration-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            "rtl/top/e1_soc_top.sv",
            "rtl/top/adapters/e1_soc_real_subsys.sv",
            "rtl/interrupts/e1_clint.sv",
            "rtl/interrupts/e1_plic.sv",
            "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
            "verify/cocotb/soc/test_e1_soc_integrated_smoke.py",
            "verify/cocotb/soc/Makefile",
        ],
        "as_of": _now(),
        "subsystem": "soc-integration",
        "claim_boundary": (
            "Behind +define+E1_SOC_REAL_IRQ / +define+E1_SOC_REAL_DRAM, "
            "e1_soc_top composes the production RISC-V CLINT (@0x0200_0000, "
            "drives mip.MSIP/MTIP), the production RISC-V PLIC v1.0.0 "
            "(@0x0C00_0000, claim/complete -> mip.MEIP), and the full-AXI4 "
            "DRAM controller (2 GiB @ 0x8000_0000) via e1_soc_real_subsys, "
            "which bridges the v0 32-bit MMIO debug aperture to the leaves' "
            "AXI-Lite / AXI4 slave ports with single-outstanding request "
            "shims. This gate proves the integrated config elaborates clean "
            "(-Wall, SoC-block style waivers only) and that the cocotb smoke "
            "exercises a real-CLINT timer interrupt, a real-PLIC external-IRQ "
            "claim/complete round-trip, and real-AXI4 DRAM word read/write "
            "with a discoverable 2 GiB capacity, all through the SoC fabric "
            "rather than standalone. It does NOT prove: real CPU execution "
            "out of DRAM (the CPU subsystem is the CVA6-disabled stub unless "
            "E1_HAVE_CVA6 + external/cva6 are added; the smoke drives the bus "
            "via the MMIO debug master); the IOMMU/IOPMP/SG-DMA/AIA path or "
            "the RoT reset sequencer (next-step); the LPDDR5X analog PHY + "
            "DFI 5.0 training (PHYSICAL dependency, "
            "docs/evidence/memory/lpddr-phy-procurement); or an OpenSBI/Linux "
            "boot (requires the CPU core, OpenSBI handoff, and a DTB whose "
            "memory node matches the controller's 2 GiB aperture)."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"gate": report["gate"], "status": status}, indent=2))
    for c in checks:
        print(f"  [{c['status'].upper()}] {c['id']}: {c['detail']}")
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
