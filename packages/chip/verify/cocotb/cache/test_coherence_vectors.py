"""MESI coherence vector cocotb tests on the L1D module.

Each vector exercises a different MESI transition path on the L1D.
The L1D module exposes:
  - LSU 2R/2W ports
  - L2 acq/grant (line fill / writeback)
  - Probe channel (downgrade M->S writes back dirty; invalidate writes back
    dirty)

This file complements `test_l1d_basic.py` with multi-step coherence
trajectories: M->S, M->I, dirty-shared invariant (no two caches in M
simultaneously is enforced upstream by the L3 directory; here we verify
that a probe to a clean line never sources data, and that probing an
M-state line forces a writeback).
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

MESI_I = 0
MESI_S = 1
MESI_E = 2
MESI_M = 3


def pack_req(paddr, size=3, is_load=1, wdata=0, wstrb=0, tag=0):
    return (
        (tag & 0xFF)
        | ((wstrb & 0xFFFF) << 8)
        | ((wdata & ((1 << 128) - 1)) << 24)
        | ((is_load & 0x1) << 152)
        | ((size & 0x7) << 153)
        | ((paddr & ((1 << 40) - 1)) << 156)
    )


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.lsu_p0_valid.value = 0
    dut.lsu_p0_req.value = 0
    dut.lsu_p1_valid.value = 0
    dut.lsu_p1_req.value = 0
    dut.l2_acq_ready.value = 1
    dut.l2_grant_valid.value = 0
    dut.l2_grant_paddr_line.value = 0
    dut.l2_grant_data.value = 0
    dut.l2_grant_state.value = MESI_S
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
    dut.probe_target_state.value = MESI_I
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for(dut, signal, cycles=64) -> int:
    for cyc in range(cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal).value) == 1:
            return cyc
    raise AssertionError(f"{signal} never asserted within {cycles} cycles")


async def grant_line(dut, paddr_line: int, data: int, state: int) -> None:
    """Wait for an outstanding l2_acq then drive a grant with given state."""
    await wait_for(dut, "l2_acq_valid")
    await RisingEdge(dut.clk)
    dut.l2_grant_valid.value = 1
    dut.l2_grant_paddr_line.value = paddr_line
    dut.l2_grant_data.value = data
    dut.l2_grant_state.value = state
    await RisingEdge(dut.clk)
    dut.l2_grant_valid.value = 0


@cocotb.test()
async def test_clean_line_probe_invalidate_no_writeback(dut):
    """Vector: line installed clean (E) -> probe invalidate -> no data
    returned on the probe channel."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_4000_0000
    line_addr = paddr & ~0x3F

    # Issue a load to trigger miss
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = pack_req(paddr, is_load=1)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0

    await grant_line(dut, line_addr, data=0, state=MESI_E)

    for _ in range(3):
        await RisingEdge(dut.clk)

    # Probe invalidate the clean line
    dut.probe_valid.value = 1
    dut.probe_paddr_line.value = line_addr
    dut.probe_target_state.value = MESI_I
    await RisingEdge(dut.clk)
    dut.probe_valid.value = 0
    await wait_for(dut, "probe_ack", cycles=8)
    assert int(dut.probe_has_data.value) == 0, "clean line should not source writeback data"


@cocotb.test()
async def test_dirty_line_probe_invalidate_writeback(dut):
    """Vector: install line as M (via store hit), probe invalidate -> data
    must be written back."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_4000_1000
    line_addr = paddr & ~0x3F

    # 1) Miss + refill as E
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = pack_req(paddr, is_load=1)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0
    await grant_line(dut, line_addr, data=0xDEAD_BEEF, state=MESI_E)
    for _ in range(2):
        await RisingEdge(dut.clk)

    # 2) Store hit -> upgrades to M (and the L1D writes the new word)
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = pack_req(paddr, is_load=0, wdata=0xCAFE_F00D, wstrb=0xFF)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0
    # Drain the response
    for _ in range(2):
        await RisingEdge(dut.clk)

    # 3) Probe invalidate -> expect probe_has_data = 1
    dut.probe_valid.value = 1
    dut.probe_paddr_line.value = line_addr
    dut.probe_target_state.value = MESI_I
    await RisingEdge(dut.clk)
    dut.probe_valid.value = 0
    await wait_for(dut, "probe_ack", cycles=8)
    assert int(dut.probe_has_data.value) == 1, "dirty line invalidate should write back"


@cocotb.test()
async def test_dirty_line_probe_downgrade_to_shared(dut):
    """Vector: install M, then probe target=S downgrades; writeback occurs
    and final_state ends at S."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_4000_2000
    line_addr = paddr & ~0x3F

    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = pack_req(paddr, is_load=1)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0
    await grant_line(dut, line_addr, data=0xFEED_FACE, state=MESI_E)
    for _ in range(2):
        await RisingEdge(dut.clk)

    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = pack_req(paddr, is_load=0, wdata=0xBADD_F00D, wstrb=0xFF)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0
    for _ in range(2):
        await RisingEdge(dut.clk)

    dut.probe_valid.value = 1
    dut.probe_paddr_line.value = line_addr
    dut.probe_target_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.probe_valid.value = 0
    await wait_for(dut, "probe_ack", cycles=8)
    assert int(dut.probe_has_data.value) == 1, "M->S downgrade should write back"
    assert int(dut.probe_final_state.value) == MESI_S, "downgrade must land in S"


@cocotb.test()
async def test_invalidate_miss_no_data(dut):
    """Vector: probe to a line never installed acks without writeback."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line_addr = 0x0000_5000_0000
    dut.probe_valid.value = 1
    dut.probe_paddr_line.value = line_addr
    dut.probe_target_state.value = MESI_I
    await RisingEdge(dut.clk)
    dut.probe_valid.value = 0
    await wait_for(dut, "probe_ack", cycles=4)
    assert int(dut.probe_has_data.value) == 0, "miss-probe should not source data"
