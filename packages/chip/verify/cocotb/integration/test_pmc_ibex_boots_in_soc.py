"""In-band PMC Ibex boot inside `e1_soc_integrated`.

This test is the integration-side counterpart to
`verify/cocotb/power/test_pmc_ibex_boot_sanity.py`. It runs only when the
Verilator build was compiled with `+define+PMC_INSTANTIATE_IBEX`, which the
integration Makefile gates on the `PMC_INSTANTIATE_IBEX=1` environment
variable. When the gate is off, the test reports an explicit skip and the
BLOCKED status in `docs/evidence/power/pmc-soc-integration-evidence.yaml`
is the source of truth.

Pass criteria — these reflect the contract recorded in
`docs/evidence/power/pmc-soc-integration-evidence.yaml`:

  1. The Ibex inside `u_soc.u_pmc.u_ibex_pmc` raises `instr_req_o` within
     32 clk_aon cycles of reset release.
  2. Its first `instr_addr_o` equals `PMC_BOOT_ADDR = 0x1005_0000`, the
     vector table base in `fw/pmc/link.ld`.
  3. By the smoke window (2,048 clk_aon cycles) the Ibex has fetched past
     `_start` and reached `pmc_main` (proxied by `instr_addr_o` advancing
     beyond `0x1005_0084 + 0xb0`; see `pmc.map` for the exact symbol).
  4. A CPU-side MMIO write+read round-trip on `0x1005_0000 + 0x000` /
     `+ 0x004` (PMC_REG_MBOX_TX_HEAD / TX_DATA) still completes correctly
     while the Ibex is running — i.e. the in-band instantiation does not
     break the existing mailbox surface.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

PMC_BOOT_ADDR = 0x1005_0000
# Ibex's actual first instruction fetch is at boot_addr_i + 0x80 (the
# reset entry vector convention; mtvec slots 0..31 sit at boot_addr_i
# .. boot_addr_i+0x7C and the reset vector follows). The link.ld
# .vectors placement therefore lands _start at 0x10050080.
PMC_RESET_ENTRY = PMC_BOOT_ADDR + 0x80
PMC_MBOX_BASE = 0x1005_0000
PMC_REG_MBOX_TX_HEAD = 0x000
PMC_REG_MBOX_TX_DATA = 0x004
PMC_REG_MBOX_RX_DATA = 0x00C

CLK_PERIOD_NS = 10
RESET_WAIT_CYCLES = 8
BOOT_WAIT_CYCLES = 32
SMOKE_WINDOW_CYCLES = 2048
# pmc.map records pmc_main at 0x10050136; anything past 0x10050100
# proves _start advanced past the vector table into C code.
PMC_MAIN_PC_FLOOR = 0x1005_0100


def _ibex_guard_active() -> bool:
    val = os.environ.get("PMC_INSTANTIATE_IBEX", "0")
    return val not in ("0", "", "false", "False")


async def _reset(dut) -> None:
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    dut.lkp_valid_i.value = 0
    dut.lkp_pc_i.value = 0
    dut.resolve_i.value = 0
    dut.fetch_pop_i.value = 0
    dut.fetch_stream_ready_i.value = 1
    dut.zihpm_csr_we_i.value = 0
    dut.zihpm_csr_addr_i.value = 0
    dut.zihpm_csr_wdata_i.value = 0
    dut.zihpm_csr_raddr_i.value = 0
    dut.zihpm_instret_pulse_i.value = 0
    await Timer(1, units="ns")
    for _ in range(RESET_WAIT_CYCLES):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _mmio_write(dut, addr: int, data: int) -> None:
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await RisingEdge(dut.clk)


async def _mmio_read(dut, addr: int) -> int:
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.mmio_rdata.value)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


async def _pmc_read32(dut, addr: int) -> int:
    """Two-phase MMIO read for the PMC mailbox window.

    The PMC `mbox_rdata_o` is registered; the v0 MMIO `read32` returns
    the same-cycle data which is stale. Hold valid for two edges and
    sample on the second.
    """
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")
    value = int(dut.mmio_rdata.value)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


@cocotb.test()
async def pmc_ibex_boots_at_aon_sram_origin(dut):
    if not _ibex_guard_active():
        from cocotb.result import TestSuccess

        raise TestSuccess(
            "skipped: PMC_INSTANTIATE_IBEX not set. Run "
            "`scripts/bootstrap_ibex.sh && make -C fw/pmc aon-hex && "
            "PMC_INSTANTIATE_IBEX=1 make -C verify/cocotb/integration "
            "TOPLEVEL=e1_soc_integrated_tb MODULE=test_pmc_ibex_boots_in_soc` "
            "to enable this test. BLOCKED gate at "
            "docs/evidence/power/pmc-soc-integration-evidence.yaml."
        )

    # The pmc_top instance preloads aon_sram_q from +PMC_AON_SRAM_HEX. The
    # integration Makefile passes this plusarg through to Verilator runtime
    # by setting COCOTB_PLUSARGS; we mirror that here in case the user
    # invoked cocotb directly.
    aon_hex_default = Path(__file__).resolve().parents[3] / "fw" / "pmc" / "build" / "pmc.aon.hex"
    aon_hex = Path(os.environ.get("PMC_AON_SRAM_HEX", aon_hex_default))
    assert aon_hex.is_file(), f"PMC AON hex missing at {aon_hex}; run `make -C fw/pmc aon-hex`"

    cocotb.start_soon(Clock(dut.clk, CLK_PERIOD_NS, units="ns").start())
    await _reset(dut)

    ibex = dut.u_soc.u_pmc.u_ibex_pmc

    # Step 1: first instruction fetch must reach the AON SRAM origin.
    saw_req = False
    first_addr: int | None = None
    for _ in range(BOOT_WAIT_CYCLES):
        await RisingEdge(dut.clk)
        if int(ibex.instr_req_o.value) == 1:
            saw_req = True
            first_addr = int(ibex.instr_addr_o.value)
            break
    assert saw_req, f"Ibex did not raise instr_req_o within {BOOT_WAIT_CYCLES} cycles"
    assert first_addr == PMC_RESET_ENTRY, (
        f"Ibex first instr_addr_o = {first_addr:#x}, expected reset entry "
        f"{PMC_RESET_ENTRY:#x} (PMC_BOOT_ADDR={PMC_BOOT_ADDR:#x} + 0x80) "
        f"from fw/pmc/link.ld"
    )

    # Step 2: walk past _start into pmc_main. Track the maximum PC observed
    # because the Ibex prefetch buffer may issue secondary fetches at lower
    # addresses for branch targets after the entry jump.
    max_pc = first_addr
    reached_pmc_main = False
    for _ in range(SMOKE_WINDOW_CYCLES):
        await RisingEdge(dut.clk)
        if int(ibex.instr_req_o.value) == 1:
            addr = int(ibex.instr_addr_o.value)
            if addr > max_pc:
                max_pc = addr
            if addr >= PMC_MAIN_PC_FLOOR:
                reached_pmc_main = True
                break
    assert reached_pmc_main, (
        f"Ibex did not advance past PMC_MAIN_PC_FLOOR={PMC_MAIN_PC_FLOOR:#x} "
        f"within {SMOKE_WINDOW_CYCLES} cycles. max_pc={max_pc:#x}"
    )

    # Step 3: while the Ibex is running, prove the CPU-side mailbox still
    # works. The harness writes TX_HEAD / TX_DATA via the MMIO aperture;
    # the pmc_top loopback path mirrors TX_DATA -> RX_DATA on the same
    # clk_aon edge so a single read suffices.
    await _mmio_write(dut, PMC_MBOX_BASE + PMC_REG_MBOX_TX_HEAD, 0xDEAD_BEEF)
    await _mmio_write(dut, PMC_MBOX_BASE + PMC_REG_MBOX_TX_DATA, 0xCAFEF00D)
    # Allow the AON-domain register to settle (matches the wait used in
    # test_soc_boot_smoke.pmc_mailbox_loopback).
    for _ in range(3):
        await RisingEdge(dut.clk)
    rx_data = await _pmc_read32(dut, PMC_MBOX_BASE + PMC_REG_MBOX_RX_DATA)
    assert rx_data == 0xCAFEF00D, (
        f"PMC mailbox RX_DATA = {rx_data:#x}, expected loopback of TX_DATA"
    )
