"""L2 cache standalone cocotb tests.

Exercises the private per-core L2 (`e1_l2_cache`) via the `e1_l2_tb`
wrapper that flattens the `mesi_e` enum ports to 2-bit logic so cocotb
can drive them without the SV enum API.

Tests:
- reset is quiescent (no spurious grants, ready)
- L1D demand load: miss -> L3 acquire -> grant -> serve -> subsequent
  access is a hit (no second L3 acquire)
- L1I demand fetch: miss -> L3 acquire -> grant -> serve as MESI_S
- L3 probe-invalidate of a clean L2 line acks without writeback
- L3 prefetch fill via L1I prefetch flag exercises the prefetch HPM
  counter and resolves through the L3 link.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

MESI_I = 0
MESI_S = 1
MESI_E = 2
MESI_M = 3


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.l1i_acq_valid.value = 0
    dut.l1i_acq_paddr_line.value = 0
    dut.l1i_acq_is_prefetch.value = 0
    dut.l1i_grant_ready.value = 1
    dut.l1d_acq_valid.value = 0
    dut.l1d_acq_paddr_line.value = 0
    dut.l1d_acq_is_write.value = 0
    dut.l1d_acq_req_state.value = MESI_S
    dut.l1d_acq_wb_data.value = 0
    dut.l1d_grant_ready.value = 1
    dut.l3_acq_ready.value = 1
    dut.l3_grant_valid.value = 0
    dut.l3_grant_paddr_line.value = 0
    dut.l3_grant_data.value = 0
    dut.l3_grant_state.value = MESI_E
    dut.l3_probe_valid.value = 0
    dut.l3_probe_paddr_line.value = 0
    dut.l3_probe_target_state.value = MESI_I
    dut.l1d_probe_ready.value = 1
    dut.l1d_probe_ack.value = 0
    dut.l1d_probe_has_data.value = 0
    dut.l1d_probe_wb_data.value = 0
    dut.l1d_probe_final_state.value = MESI_I
    dut.ptw_req_valid.value = 0
    dut.ptw_req_paddr.value = 0
    dut.ptw_req_is_write.value = 0
    dut.ptw_req_wdata.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for(dut, signal: str, max_cycles: int = 64) -> int:
    for cyc in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal).value) == 1:
            return cyc
    raise AssertionError(f"{signal} never asserted within {max_cycles} cycles")


async def serve_l3_grant(dut, paddr_line: int, data: int, state: int) -> None:
    """Wait for an outstanding l3_acq then drive a grant with given state."""
    await wait_for(dut, "l3_acq_valid")
    # Hold ready and drive grant the cycle after the acq is consumed.
    await RisingEdge(dut.clk)
    dut.l3_grant_valid.value = 1
    dut.l3_grant_paddr_line.value = paddr_line
    dut.l3_grant_data.value = data
    dut.l3_grant_state.value = state
    await RisingEdge(dut.clk)
    dut.l3_grant_valid.value = 0


@cocotb.test()
async def test_l2_reset_quiescent(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    await RisingEdge(dut.clk)
    assert int(dut.l1i_grant_valid.value) == 0
    assert int(dut.l1d_grant_valid.value) == 0
    assert int(dut.l3_acq_valid.value) == 0
    assert int(dut.l1d_probe_valid.value) == 0


@cocotb.test()
async def test_l2_l1d_miss_then_hit(dut):
    """L1D miss path: L2 must request to L3, then serve once L3 grants."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_2000_0000
    line = paddr & ~0x3F

    # Issue L1D acquire (load, state=S)
    dut.l1d_acq_valid.value = 1
    dut.l1d_acq_paddr_line.value = line
    dut.l1d_acq_is_write.value = 0
    dut.l1d_acq_req_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.l1d_acq_valid.value = 0

    await serve_l3_grant(dut, line, data=0xCAFE_F00D_DEAD_BEEF, state=MESI_E)

    # L1D grant should fire
    await wait_for(dut, "l1d_grant_valid")
    assert int(dut.l1d_grant_paddr_line.value) == line

    # Drain the grant
    for _ in range(2):
        await RisingEdge(dut.clk)

    # Second access to the same line: must be a hit (no l3_acq pulse).
    pre_miss = int(dut.hpm_l2_miss.value)
    dut.l1d_acq_valid.value = 1
    dut.l1d_acq_paddr_line.value = line
    dut.l1d_acq_is_write.value = 0
    dut.l1d_acq_req_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.l1d_acq_valid.value = 0

    saw_hit = False
    saw_l3_acq = False
    for _ in range(8):
        await RisingEdge(dut.clk)
        if int(dut.l1d_grant_valid.value) == 1:
            saw_hit = True
        if int(dut.l3_acq_valid.value) == 1:
            saw_l3_acq = True
    assert saw_hit, "L2 must respond to the L1D hit"
    assert not saw_l3_acq, "L2 must not issue an L3 acquire on a hit"
    _ = pre_miss


@cocotb.test()
async def test_l2_l1i_miss_then_serve(dut):
    """L1I miss path: L2 must serve from L3 with MESI_S state."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_3000_0000
    line = paddr & ~0x3F

    dut.l1i_acq_valid.value = 1
    dut.l1i_acq_paddr_line.value = line
    dut.l1i_acq_is_prefetch.value = 0
    await RisingEdge(dut.clk)
    dut.l1i_acq_valid.value = 0

    await serve_l3_grant(dut, line, data=0x1122_3344_5566_7788, state=MESI_S)

    await wait_for(dut, "l1i_grant_valid")
    assert int(dut.l1i_grant_paddr_line.value) == line
    assert int(dut.l1i_grant_state.value) == MESI_S


@cocotb.test()
async def test_l2_l3_probe_clean_no_writeback(dut):
    """L3 probe on a clean L2 line acks without data."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_4000_0000
    line = paddr & ~0x3F

    # Install a clean (E) line via L1D miss
    dut.l1d_acq_valid.value = 1
    dut.l1d_acq_paddr_line.value = line
    dut.l1d_acq_is_write.value = 0
    dut.l1d_acq_req_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.l1d_acq_valid.value = 0
    await serve_l3_grant(dut, line, data=0, state=MESI_E)
    await wait_for(dut, "l1d_grant_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    # Probe the line; expect ack without writeback data
    dut.l3_probe_valid.value = 1
    dut.l3_probe_paddr_line.value = line
    dut.l3_probe_target_state.value = MESI_I
    await RisingEdge(dut.clk)
    dut.l3_probe_valid.value = 0

    await wait_for(dut, "l3_probe_ack", max_cycles=8)
    assert int(dut.l3_probe_has_data.value) == 0, "clean probe must not source writeback"


@cocotb.test()
async def test_l2_prefetch_fill_from_l3(dut):
    """An L1I prefetch (acq with is_prefetch=1) flows through the L3 link
    and pulses the prefetch HPM event."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_5000_0000
    line = paddr & ~0x3F

    dut.l1i_acq_valid.value = 1
    dut.l1i_acq_paddr_line.value = line
    dut.l1i_acq_is_prefetch.value = 1
    await RisingEdge(dut.clk)
    dut.l1i_acq_valid.value = 0
    dut.l1i_acq_is_prefetch.value = 0

    # Poll the L1I grant and the prefetch HPM event jointly. The L2 RTL
    # asserts hpm_l2_prefetch in the same cycle as the l1i_grant; the
    # surrounding wait_for must sample both signals on every cycle.
    await serve_l3_grant(dut, line, data=0xA5A5_A5A5_A5A5_A5A5, state=MESI_S)
    saw_pf = False
    saw_grant = False
    for _ in range(32):
        await RisingEdge(dut.clk)
        if int(dut.l1i_grant_valid.value) == 1:
            saw_grant = True
        if int(dut.hpm_l2_prefetch.value) == 1:
            saw_pf = True
        if saw_grant and saw_pf:
            break
    assert saw_grant, "L1I grant must fire on prefetch fill"
    assert saw_pf, "prefetch HPM event must pulse on prefetch fill"
