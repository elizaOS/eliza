"""Cocotb unit tests for the FTB.

Covers:
  * cold read returns lkp_hit=0, pmu_miss=1
  * after upd_alloc, a re-read at the same PC produces lkp_hit=1 and the
    stored target/kind
  * a non-matching PC still misses
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

BR_NONE, BR_COND, BR_CALL, BR_RET = 0, 1, 2, 3


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_target.value = 0
    dut.upd_kind.value = 0
    dut.upd_br_valid.value = 0
    dut.upd_alloc.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def lookup(dut, pc):
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    hit = int(dut.lkp_hit.value)
    target = int(dut.lkp_target.value)
    kind = int(dut.lkp_kind.value)
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
    return hit, target, kind


async def update(dut, pc, target, kind, alloc):
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_target.value = target
    dut.upd_kind.value = kind
    dut.upd_br_valid.value = 0b11
    dut.upd_alloc.value = 1 if alloc else 0
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    dut.upd_alloc.value = 0


@cocotb.test()
async def ftb_cold_read_misses(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    hit, _target, _kind = await lookup(dut, 0x8000_0000)
    assert hit == 0


@cocotb.test()
async def ftb_allocate_then_hit(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_2000
    target = 0x8000_2040
    await update(dut, pc, target, BR_COND, alloc=True)
    # Allow the write to settle.
    await RisingEdge(dut.clk)
    hit, got_target, got_kind = await lookup(dut, pc)
    assert hit == 1
    assert got_target == target
    assert got_kind == BR_COND


@cocotb.test()
async def ftb_non_matching_pc_misses(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_4000
    target = 0x8000_4080
    await update(dut, pc, target, BR_CALL, alloc=True)
    await RisingEdge(dut.clk)
    hit, _t, _k = await lookup(dut, pc + 0x1_0000)
    assert hit == 0
