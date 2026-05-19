"""Cocotb unit tests for TAGE direction predictor.

Drives small synthetic resolve sequences and verifies that:
  * cold state: lkp_provider == 0 (bimodal-only)
  * after many same-direction resolves at one PC, the bimodal converges
  * tagged tables can be allocated on misprediction
"""

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
    dut.upd_taken.value = 0
    dut.upd_misp.value = 0
    dut.upd_provider.value = 0
    dut.useful_reset_lsb.value = 0
    dut.useful_reset_msb.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def tage_cold_provider_is_bimodal(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = 0x8000_0000
    await Timer(1, units="ps")
    assert int(dut.lkp_provider.value) == 0
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def tage_bimodal_converges_on_repeat_taken(dut):
    """Drive 16 taken resolves on the same PC and read back lkp_taken == 1."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_4000
    for _ in range(16):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_taken.value = 1
        dut.upd_misp.value = 0
        dut.upd_provider.value = 0
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_taken.value) == 1
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def tage_allocation_on_misprediction(dut):
    """A misprediction with upd_provider=0 should trigger an allocation
    in one of the tagged tables. The allocation policy reads tab_useful at
    the *lookup* hash so we drive lkp_pc to the same PC. We observe pmu_alloc
    strobing."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8000
    alloc_seen = False
    for _ in range(8):
        # Drive the lookup path so tab_useful is observed at the same hash
        # the alloc candidate picker reads.
        dut.lkp_valid.value = 1
        dut.lkp_pc.value = pc
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_taken.value = 1
        dut.upd_misp.value = 1
        dut.upd_provider.value = 0
        await RisingEdge(dut.clk)
        if int(dut.pmu_alloc.value):
            alloc_seen = True
    dut.upd_valid.value = 0
    dut.lkp_valid.value = 0
    # At least one allocation should have fired by the end of the loop.
    assert alloc_seen
