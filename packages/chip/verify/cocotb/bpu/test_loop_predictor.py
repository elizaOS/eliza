"""Cocotb unit tests for the loop predictor.

The loop predictor learns the iteration count of a backward conditional
branch and overrides TAGE-SC when its confidence is saturated. We exercise
the simple case: drive a single backward branch with a stable trip count
and observe that pmu_hit eventually asserts (after the confidence ramp).
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

LOOP_TAG_W = 14


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_target.value = 0
    dut.upd_taken.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def loop_reset_state_is_idle(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = 0x8000_0000
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


async def drive_loop_trip(dut, pc, target, trip_count):
    for _ in range(trip_count - 1):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_target.value = target
        dut.upd_taken.value = 1
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_target.value = target
    dut.upd_taken.value = 0
    await RisingEdge(dut.clk)


def loop_tag(pc):
    folded = 0
    for bit in range(64):
        if (pc >> bit) & 1:
            folded ^= 1 << (bit % LOOP_TAG_W)
    return folded


@cocotb.test()
async def loop_trains_on_stable_trip_count(dut):
    """A stable 8-iteration loop should saturate confidence, predict the
    taken body iterations, then predict the exit at the learned bound."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_2000
    target = pc - 0x40
    trip_count = 8

    for _ in range(8):
        await drive_loop_trip(dut, pc, target, trip_count)
    dut.upd_valid.value = 0

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    await RisingEdge(dut.clk)

    for _ in range(trip_count - 1):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_target.value = target
        dut.upd_taken.value = 1
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 0
    dut.lkp_valid.value = 0


@cocotb.test()
async def loop_replacement_preserves_confident_hot_loop(dut):
    """One-shot loop allocation churn should evict weak/old entries before
    a saturated loop entry."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    hot_pc = 0x8000_4000
    hot_target = hot_pc - 0x40
    hot_trip_count = 8

    for _ in range(8):
        await drive_loop_trip(dut, hot_pc, hot_target, hot_trip_count)

    used_tags = {loop_tag(hot_pc)}
    churn_pcs: list[int] = []
    candidate = 0x8001_0000
    while len(churn_pcs) < 80:
        tag = loop_tag(candidate)
        if tag not in used_tags:
            churn_pcs.append(candidate)
            used_tags.add(tag)
        candidate += 4

    for pc in churn_pcs:
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_target.value = pc - 0x20
        dut.upd_taken.value = 1
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = hot_pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    dut.lkp_valid.value = 0
