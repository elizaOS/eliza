#!/usr/bin/env python3
"""Display framebuffer-scanout gate.

Proves that rtl/display/e1_display_scanout.sv is a real framebuffer-to-scanout
controller -- a genuine AXI4 read master + line FIFO + pixel-format unpack +
register-programmed mode timing -- and not an MMIO-poked pixel stub:

  1. Verilator --lint-only must be clean for the AXI4 package + the scanout RTL
     + the cocotb testbench.
  2. The cocotb suite verify/cocotb/display/test_display_scanout.py must pass in
     full, including:
       * scanout_xrgb8888_matches_framebuffer   (XR24 DPI stream == framebuffer)
       * scanout_rgb565_unpacks_correctly        (RGB565 -> RGB888 expansion)
       * scanout_rgb888_packed                   (packed 24bpp byte-assembly)
       * timing_matches_programmed_mode          (hsync/vsync/de == mode regs)
       * forced_underflow_sets_status_and_recovers (fail-closed underflow + W1C)
       * disabled_state_blocks_axi_and_pixels    (disabled state is quiet)
       * unsupported_format_write_is_ignored      (invalid fourcc rejected)
       * framebuffer_ar_addresses_are_monotonic_and_stride_aligned
       * axi_error_sets_underflow_status          (SLVERR/DECERR visible)
       * dcs_and_irq_vsync_cadence_matches_mode   (DCS/IRQ vsync cadence)

Writes build/reports/display_scanout.json (schema eliza.gate_status.v1).
PASS only when lint is clean and every required test passes; otherwise the
gate fails closed with the failing stage named in the blocker.

PHYSICAL DEPENDENCY: the DSI analog PHY, D-PHY lane serializers, and panel DCS
init are physical/analog and are out of RTL scope. This gate proves the digital
controller -> PHY (DPI/DSI) boundary only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/display_scanout.json"

AXI4_PKG = "rtl/interconnect/axi4/e1_axi4_pkg.sv"
SCANOUT_RTL = "rtl/display/e1_display_scanout.sv"
TB = "verify/cocotb/display/e1_display_scanout_tb.sv"
TEST = "verify/cocotb/display/test_display_scanout.py"

REQUIRED_TESTS = (
    "scanout_xrgb8888_matches_framebuffer",
    "scanout_rgb565_unpacks_correctly",
    "scanout_rgb888_packed",
    "timing_matches_programmed_mode",
    "forced_underflow_sets_status_and_recovers",
    "disabled_state_blocks_axi_and_pixels",
    "unsupported_format_write_is_ignored",
    "framebuffer_ar_addresses_are_monotonic_and_stride_aligned",
    "axi_error_sets_underflow_status",
    "dcs_and_irq_vsync_cadence_matches_mode",
)

# A real scanout datapath must not regress to MMIO-poked pixels: these tokens
# prove the AXI4 read master, the line FIFO, the byte-assembly format unpack,
# the register-programmed mode timing, and the fail-closed underflow policy are
# present in the RTL.
REQUIRED_RTL_TOKENS = (
    "m_arvalid",
    "m_arqos",
    "QOS_DISPLAY_RT",
    "BURST_INCR",
    "outstanding_cnt",
    "fifo_mem",
    "byte_buf",
    "UNDERFLOW_FILL",
    "underflow_sticky",
    "pix_de",
    "pix_hsync",
    "pix_vsync",
    "dcs_vsync_pulse",
)

LINT_WAIVERS = [
    "-Wno-UNUSEDPARAM",  # shared AXI4 package exposes the full constant table
]


def tool_path(name: str) -> str:
    local = ROOT / "external/oss-cad-suite/bin" / name
    if local.exists():
        return str(local)
    return name


def write_report(status: str, blocker_id, blocker_reason, detail) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.gate_status.v1",
                "gate": "display-scanout-check",
                "status": status,
                "blocker_id": blocker_id,
                "blocker_reason": blocker_reason,
                "evidence_paths": [SCANOUT_RTL, AXI4_PKG, TB, TEST],
                "as_of": datetime.now(UTC).isoformat(),
                "subsystem": "display",
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "panel_bringup_claim_allowed": False,
                "dsi_phy_claim_allowed": False,
                "drm_kms_claim_allowed": False,
                "claim_boundary": (
                    "Proves the buildable display scanout subset: a real AXI4 "
                    "read master (INCR bursts, QoS=DISPLAY_RT, multiple "
                    "outstanding reads) streaming a framebuffer from DRAM "
                    "through a line FIFO with a fail-closed underflow policy, a "
                    "byte-assembly pixel-format unpack (RGB565 / packed RGB888 "
                    "/ XRGB8888), register-programmed H/V mode timing, and the "
                    "digital controller -> PHY (DPI/DSI) pixel + DCS-command "
                    "boundary, verified under Verilator + cocotb. Does NOT "
                    "cover the DSI analog PHY, D-PHY lane serializers, panel "
                    "DCS init, async pixel-clock CDC, or DRM/KMS/compositor "
                    "software -- those are physical/analog dependencies and "
                    "SoC-fabric/DTS follow-ons."
                ),
                "physical_dependency": (
                    "DSI analog PHY + D-PHY lane serializers + panel DCS init "
                    "are physical/analog and out of RTL scope; modelled at the "
                    "DPI/DSI command+pixel boundary only."
                ),
                "required_tests": list(REQUIRED_TESTS),
                "detail": detail,
            },
            indent=2,
        )
        + "\n"
    )


def verilator_lint() -> tuple[bool, str]:
    cmd = [
        tool_path("verilator"),
        "--lint-only",
        "-Wall",
        *LINT_WAIVERS,
        "--top-module",
        "e1_display_scanout_tb",
        str(ROOT / AXI4_PKG),
        str(ROOT / SCANOUT_RTL),
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
            "COCOTB_MODULE": "test_display_scanout",
            "COCOTB_TOPLEVEL": "e1_display_scanout_tb",
            "COCOTB_DIR": "verify/cocotb/display",
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
    text = (ROOT / SCANOUT_RTL).read_text()
    missing = [tok for tok in REQUIRED_RTL_TOKENS if tok not in text]
    return (not missing), missing


def check_required_tests_present() -> tuple[bool, list[str]]:
    text = (ROOT / TEST).read_text()
    missing = [t for t in REQUIRED_TESTS if f"async def {t}" not in text]
    return (not missing), missing


def main() -> int:
    for rel in (AXI4_PKG, SCANOUT_RTL, TB, TEST):
        if not (ROOT / rel).is_file():
            write_report("BLOCKED", "missing_source", f"missing {rel}", {})
            print(f"BLOCKED: missing {rel}")
            return 1

    tokens_ok, missing_tokens = check_rtl_tokens()
    if not tokens_ok:
        write_report(
            "BLOCKED",
            "scanout_rtl_absent",
            "RTL is missing real scanout datapath tokens: " + ", ".join(missing_tokens),
            {"missing_rtl_tokens": missing_tokens},
        )
        print("BLOCKED: scanout RTL tokens missing:", ", ".join(missing_tokens))
        return 1

    tests_ok, missing_tests = check_required_tests_present()
    if not tests_ok:
        write_report(
            "BLOCKED",
            "required_tests_absent",
            "cocotb suite is missing required scanout tests: " + ", ".join(missing_tests),
            {"missing_tests": missing_tests},
        )
        print("BLOCKED: required tests missing:", ", ".join(missing_tests))
        return 1

    lint_ok, lint_log = verilator_lint()
    if not lint_ok:
        write_report(
            "BLOCKED",
            "verilator_lint_failed",
            "Verilator --lint-only reported errors on the scanout RTL.",
            {"lint_log_tail": lint_log[-2000:]},
        )
        print("BLOCKED: verilator lint failed")
        print(lint_log[-2000:])
        return 1

    sim_ok, sim_log = run_cocotb()
    if not sim_ok:
        write_report(
            "BLOCKED",
            "cocotb_scanout_suite_failed",
            "The cocotb display scanout suite did not pass cleanly.",
            {"sim_log_tail": sim_log[-2000:]},
        )
        print("BLOCKED: cocotb scanout suite failed")
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
    print("PASS: display framebuffer-scanout gate")
    print("  verilator --lint-only: clean")
    print(f"  cocotb {TEST}: all tests pass (FAIL=0)")
    print(f"  required scanout tests: {len(REQUIRED_TESTS)} present and green")
    print(f"  report: {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
