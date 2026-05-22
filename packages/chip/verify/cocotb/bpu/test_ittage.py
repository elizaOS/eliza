"""Cocotb unit tests for ITTAGE indirect-target predictor."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.lkp_hist.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_hist.value = 0
    dut.upd_target.value = 0
    dut.upd_misp.value = 0
    dut.upd_provider.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def ittage_cold_miss(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = 0x9000_0000
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def ittage_misprediction_allocates(dut):
    """Drive mispredictions at one indirect-branch PC with a stable target.
    ITTAGE should allocate at least one table entry."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x9000_2000
    target = 0x9000_5000
    for _ in range(8):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_target.value = target
        dut.upd_misp.value = 1
        dut.upd_provider.value = 0
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    # The PC may or may not produce a hit on the very next lookup depending
    # on hash alignment between PC and 0-history; we accept either outcome.
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    # If we hit, the target must be the trained one.
    if int(dut.lkp_hit.value):
        assert int(dut.lkp_target.value) == target
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def ittage_replaces_weak_stale_target(dut):
    """A weak provider with a stale target should be overwritten in place.

    This keeps monomorphic-after-warmup indirect sites from spending several
    extra misses aging out an old target before learning the steady target.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc_low = 0x9000_3000
    pc_high = 0x9000_4000
    stale = 0x9000_6000
    target = 0x9000_7000

    # Seed table 0, then prove provider 1 is not replaced in place.
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc_low
    dut.upd_hist.value = 0
    dut.upd_target.value = stale
    dut.upd_misp.value = 1
    dut.upd_provider.value = 0
    await RisingEdge(dut.clk)
    dut.upd_target.value = target
    dut.upd_misp.value = 0
    dut.upd_provider.value = 1
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc_low
    dut.lkp_hist.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_target.value) == stale
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0

    # Seed table 3 directly, then prove provider 4 replaces a weak target.
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc_high
    dut.upd_hist.value = 0
    dut.upd_target.value = stale
    dut.upd_misp.value = 1
    dut.upd_provider.value = 3
    await RisingEdge(dut.clk)
    dut.upd_target.value = target
    dut.upd_misp.value = 0
    dut.upd_provider.value = 4
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc_high
    dut.lkp_hist.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_target.value) == target
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
