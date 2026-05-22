"""cocotb suite for the production E1 CLINT (rtl/interrupts/e1_clint.sv).

The CLINT is the RISC-V Core-Local Interruptor: it provides the timer
(mtime/mtimecmp -> mip.MTIP) and software (msip -> mip.MSIP) interrupts that
Linux/AOSP require to boot. This suite drives the module's 32-bit AXI-Lite slave
at the canonical SiFive/RISC-V (riscv,clint0 / sifive,clint0) register map and
asserts the per-hart mtip_o/msip_o outputs behave per spec.

Register map (window-relative byte offsets, NUM_HARTS=2 in the testbench):
    +0x0000 + 4*hart : msip[hart]      RW32, bit0 = software-interrupt pending
    +0x4000 + 8*hart : mtimecmp[hart]  RW64 (lo @ +0, hi @ +4)
    +0xBFF8          : mtime           RW64 (lo @ +0, hi @ +4), free-running

Contracts:
  * mtime free-runs and is monotonically increasing;
  * MTIP for hart h asserts exactly when mtime >= mtimecmp[h], and clears when
    mtimecmp[h] is rewritten above mtime;
  * a timer programmed mtimecmp = mtime + N fires after the expected delay;
  * MSIP for hart h tracks msip[h].bit0 (set/clear within one cycle);
  * per-hart isolation: programming hart 0 does not perturb hart 1.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

CLINT_MSIP_BASE = 0x0000
CLINT_MTIMECMP_BASE = 0x4000
CLINT_MTIME_LO = 0xBFF8
CLINT_MTIME_HI = 0xBFFC


def _msip(hart: int) -> int:
    return CLINT_MSIP_BASE + 4 * hart


def _mtimecmp_lo(hart: int) -> int:
    return CLINT_MTIMECMP_BASE + 8 * hart


def _mtimecmp_hi(hart: int) -> int:
    return CLINT_MTIMECMP_BASE + 8 * hart + 4


async def _reset(dut):
    dut.rst_n.value = 0
    dut.s_axil_awvalid.value = 0
    dut.s_axil_awaddr.value = 0
    dut.s_axil_wvalid.value = 0
    dut.s_axil_wdata.value = 0
    dut.s_axil_wstrb.value = 0
    dut.s_axil_bready.value = 1
    dut.s_axil_arvalid.value = 0
    dut.s_axil_araddr.value = 0
    dut.s_axil_rready.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _w32(dut, addr, data):
    dut.s_axil_awaddr.value = addr
    dut.s_axil_wdata.value = data
    dut.s_axil_wstrb.value = 0xF
    dut.s_axil_awvalid.value = 1
    dut.s_axil_wvalid.value = 1
    while not (int(dut.s_axil_awready.value) and int(dut.s_axil_wready.value)):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.s_axil_awvalid.value = 0
    dut.s_axil_wvalid.value = 0
    while not int(dut.s_axil_bvalid.value):
        await RisingEdge(dut.clk)
    resp = int(dut.s_axil_bresp.value)
    await RisingEdge(dut.clk)
    return resp


async def _r32(dut, addr):
    dut.s_axil_araddr.value = addr
    dut.s_axil_arvalid.value = 1
    while not int(dut.s_axil_arready.value):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.s_axil_arvalid.value = 0
    while not int(dut.s_axil_rvalid.value):
        await RisingEdge(dut.clk)
    data = int(dut.s_axil_rdata.value)
    resp = int(dut.s_axil_rresp.value)
    await RisingEdge(dut.clk)
    return data, resp


async def _read_mtime(dut):
    lo, _ = await _r32(dut, CLINT_MTIME_LO)
    hi, _ = await _r32(dut, CLINT_MTIME_HI)
    return (hi << 32) | lo


def _mtip(dut, hart: int) -> int:
    return (int(dut.mtip_o.value) >> hart) & 0x1


def _msip_out(dut, hart: int) -> int:
    return (int(dut.msip_o.value) >> hart) & 0x1


@cocotb.test()
async def clint_mtime_monotonic(dut):
    """mtime free-runs and is strictly increasing across cycles."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)
    t0 = await _read_mtime(dut)
    for _ in range(8):
        await RisingEdge(dut.clk)
    t1 = await _read_mtime(dut)
    assert t1 > t0, f"mtime not monotonic: {t0} -> {t1}"


@cocotb.test()
async def clint_timer_irq_fires_when_mtime_ge_mtimecmp(dut):
    """Program mtimecmp = mtime + N; MTIP must assert once mtime catches up,
    and clear when mtimecmp is rewritten above mtime."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # mtimecmp resets to all-ones, so MTIP is low.
    assert _mtip(dut, 0) == 0, "MTIP asserted at reset with mtimecmp=all-ones"

    now = await _read_mtime(dut)
    target = now + 40
    await _w32(dut, _mtimecmp_hi(0), (target >> 32) & 0xFFFFFFFF)
    await _w32(dut, _mtimecmp_lo(0), target & 0xFFFFFFFF)

    # MTIP must still be low until mtime reaches target.
    assert _mtip(dut, 0) == 0, "MTIP fired before mtime reached mtimecmp"

    # Advance until mtime >= target.
    fired_at = None
    for _ in range(200):
        await RisingEdge(dut.clk)
        if _mtip(dut, 0) == 1:
            fired_at = await _read_mtime(dut)
            break
    assert fired_at is not None, "MTIP never asserted"
    assert fired_at >= target, f"MTIP fired at mtime={fired_at} < mtimecmp={target}"

    # Rewrite mtimecmp far in the future -> MTIP must clear.
    future = fired_at + 1_000_000
    await _w32(dut, _mtimecmp_hi(0), (future >> 32) & 0xFFFFFFFF)
    await _w32(dut, _mtimecmp_lo(0), future & 0xFFFFFFFF)
    await RisingEdge(dut.clk)
    assert _mtip(dut, 0) == 0, "MTIP did not clear after mtimecmp moved forward"


@cocotb.test()
async def clint_msip_software_interrupt(dut):
    """Writing 1 to msip[0] asserts MSIP; writing 0 clears it."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    assert _msip_out(dut, 0) == 0, "MSIP set at reset"

    await _w32(dut, _msip(0), 1)
    await RisingEdge(dut.clk)
    assert _msip_out(dut, 0) == 1, "MSIP did not assert after msip=1"
    val, _ = await _r32(dut, _msip(0))
    assert val & 1 == 1, f"msip readback wrong: {val}"

    await _w32(dut, _msip(0), 0)
    await RisingEdge(dut.clk)
    assert _msip_out(dut, 0) == 0, "MSIP did not clear after msip=0"


@cocotb.test()
async def clint_per_hart_isolation(dut):
    """Programming hart 0 (timer + software IRQ) must not perturb hart 1."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # Fire hart 0's timer immediately (mtimecmp = 0) and set its msip.
    await _w32(dut, _mtimecmp_hi(0), 0)
    await _w32(dut, _mtimecmp_lo(0), 0)
    await _w32(dut, _msip(0), 1)
    await RisingEdge(dut.clk)

    assert _mtip(dut, 0) == 1, "hart0 MTIP should fire (mtimecmp=0)"
    assert _msip_out(dut, 0) == 1, "hart0 MSIP should be set"
    assert _mtip(dut, 1) == 0, "hart1 MTIP should be quiet (mtimecmp=all-ones)"
    assert _msip_out(dut, 1) == 0, "hart1 MSIP should be quiet"
