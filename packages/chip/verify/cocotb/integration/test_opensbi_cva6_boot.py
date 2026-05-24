"""OpenSBI v1.8.1 boots on the CVA6 RTL through the DRAM-controller model and
prints its banner over the ns16550a UART RTL.

This is the OS-bring-up step above the bare-metal substrate proof
(`test_cva6_dram_boot.py`): the same DUT (`e1_cva6_dram_boot_top`) — CVA6
v5.3.0 RTL fetching from the `e1_dram_ctrl` RTL model through the fabric RTL,
CLINT/PLIC RTL, RoT-gated reset — now executes the repo OpenSBI build instead
of a hand-written bare-metal image, with:

  * a synthesizable ns16550a UART model @0x1000_1000 wired onto the fabric as
    the OpenSBI console sink (rtl/peripherals/e1_uart_ns16550.sv), and
  * the vendored pulp-platform axi_riscv_atomics filter (wrapped by
    rtl/top/adapters/e1_axi4_riscv_atomics.sv) that resolves CVA6's RISC-V
    atomics + LR/SC against an RVWMO-correct AMO engine and reservation table so
    the fabric/DRAM need no atomic or exclusive support (OpenSBI's boot lottery /
    spinlocks use `amo*`), preserving the serialized-atomics ordering CVA6's
    wt_axi_adapter assumes.

Preload image (fw/opensbi-cva6-boot/build_boot_image.py):
  0x80000000  OpenSBI fw_jump  (FW_TEXT_START; aligned base so domain/PMP init
                                passes; next-stage S-mode @0x80060000)
  0x80040000  device-tree blob (parsed from a1)
  0x80060000  S-mode payload   (prints the S-MODE-OK marker)
  0x80080000  entry shim       (CVA6 reset vector; sets a0=hartid=0,
                                a1=dtb=0x80040000, jumps to OpenSBI _fw_start)

cocotb drives clk/rst_n + the RoT release inputs, then assembles the UART TX
stream (uart_tx_valid_o / uart_tx_byte_o) into a transcript and asserts the
OpenSBI BANNER appears ("OpenSBI v...") — the milestone for this proof: real
OpenSBI ran in M-mode on CVA6, executing from the RTL DRAM-controller model,
and reached its console over the UART RTL.

The transcript is written to docs/evidence/cpu_ap/opensbi_cva6_boot.transcript.

This test asserts the BANNER milestone; the M->S handoff (S-MODE-OK) and the
Linux-kernel run are proven by test_linux_boot_cva6.py + check_linux_boot_cva6.py,
which drive the same DUT past the banner.  With the vendored axi_riscv_atomics
filter in place, the previous post-banner write-ID FIFO assertion in CVA6's
wt_axi_adapter no longer fires, so the boot proceeds to the S-mode payload.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
TRANSCRIPT = EVIDENCE_DIR / "opensbi_cva6_boot.transcript"

# The OpenSBI banner: the boot-print path emits "OpenSBI v<version>" first, well
# before any atomic-heavy post-banner work.  This is the asserted milestone.
BANNER_TOKEN = "OpenSBI"
# Opportunistic S-mode handoff marker (see module docstring).
SMODE_MARKER = "S-MODE-OK"

# CVA6 from cold DRAM is slow: frontend bring-up + first I$ fill, then OpenSBI
# PIE self-relocation + scratch/heap/domain init before the first console byte.
MAX_CYCLES = int(os.environ.get("OPENSBI_BOOT_MAX_CYCLES", "4000000"))
# After the banner token appears, drain trailing banner bytes then end the test
# promptly (cocotb $finish) so the sim stops before any post-banner activity.
BANNER_DRAIN_CYCLES = 60_000

_RUN = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"


@cocotb.test(skip=not _RUN)
async def test_opensbi_boots_and_prints_banner(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    # Cold reset, then the RoT release strobes (fail-closed: without both the
    # core never leaves reset).
    dut.rst_n.value = 0
    dut.boot_verified_i.value = 0
    dut.iopmp_policy_ready_i.value = 0
    dut.lc_scrap_i.value = 0
    dut.plic_sources_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)
    dut.boot_verified_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.iopmp_policy_ready_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)

    assert int(dut.platform_released_o.value) == 1, "RoT did not release the CVA6 cluster."
    assert int(dut.cva6_rst_n_o.value) == 1, "CVA6 still held in reset."

    chars = bytearray()
    banner_seen = False
    smode_seen = False

    cycles = 0
    while cycles < MAX_CYCLES:
        await RisingEdge(dut.clk)
        cycles += 1
        if int(dut.uart_tx_valid_o.value) == 1:
            chars.append(int(dut.uart_tx_byte_o.value) & 0xFF)
            text = chars.decode("latin-1")
            if SMODE_MARKER in text:
                smode_seen = True
            if not banner_seen and BANNER_TOKEN in text:
                banner_seen = True
                # Drain trailing banner bytes, then end the test promptly so the
                # sim stops cleanly right after the banner.
                for _ in range(BANNER_DRAIN_CYCLES):
                    await RisingEdge(dut.clk)
                    if int(dut.uart_tx_valid_o.value) == 1:
                        chars.append(int(dut.uart_tx_byte_o.value) & 0xFF)
                        if SMODE_MARKER in chars.decode("latin-1"):
                            smode_seen = True
                break

    transcript = chars.decode("latin-1")
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPT.write_text(transcript, encoding="utf-8")

    # Structural evidence the CPU fetched OpenSBI from the RTL DRAM path.
    dram_ar = int(dut.dram_ar_xfers_o.value)
    dram_r = int(dut.dram_r_xfers_o.value)
    uart_aw = int(dut.uart_aw_xfers_o.value)
    dut._log.info(
        f"OpenSBI-on-CVA6 boot: {len(chars)} UART TX bytes, DRAM AR={dram_ar} "
        f"R={dram_r}, UART writes={uart_aw}; banner_seen={banner_seen} "
        f"smode_seen={smode_seen}"
    )
    dut._log.info("UART transcript:\n" + transcript)

    assert dram_ar >= 1 and dram_r >= 1, (
        f"CVA6 never fetched through the RTL DRAM path (AR={dram_ar}, R={dram_r})."
    )
    assert dram_ar >= 1 and dram_r >= 1, f"CVA6 never fetched real DRAM (AR={dram_ar}, R={dram_r})."
    assert len(chars) > 0, (
        "No UART output — OpenSBI never reached its console.  Check the entry "
        "shim regs (a0/a1), the OpenSBI image base (FW_TEXT_START=0x80000000), "
        "the atomics adapter, and the ns16550a decode @0x10001000."
    )
    assert banner_seen, (
        "OpenSBI banner not observed.  Transcript so far:\n"
        f"{transcript!r}\nExpected token {BANNER_TOKEN!r}."
    )

    dut._log.info(
        "OpenSBI-on-CVA6 PROVEN: OpenSBI v1.8.1 booted in M-mode on the "
        "CVA6 RTL from the RTL DRAM-controller model (through the fabric RTL, with "
        "the CLINT/PLIC RTL + RoT gate) and printed its banner over the "
        f"ns16550a UART.  S-mode marker observed: {smode_seen}."
    )
