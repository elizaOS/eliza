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
VADDR_W = 39


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.lkp_path_sig.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_path_sig.value = 0
    dut.upd_target.value = 0
    dut.upd_taken.value = 0
    dut.test_corrupt_parity_valid.value = 0
    dut.test_corrupt_parity_pc.value = 0
    dut.test_corrupt_parity_path_sig.value = 0
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


async def drive_loop_trip(dut, pc, target, trip_count, path_sig=0):
    for _ in range(trip_count - 1):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_path_sig.value = path_sig
        dut.upd_target.value = target
        dut.upd_taken.value = 1
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_path_sig.value = path_sig
    dut.upd_target.value = target
    dut.upd_taken.value = 0
    await RisingEdge(dut.clk)


def loop_tag(pc):
    folded = 0
    for bit in range(VADDR_W):
        if (pc >> bit) & 1:
            folded ^= 1 << (bit % LOOP_TAG_W)
    return folded


def loop_pc_signature(pc):
    return ((pc >> 14) & 0xFF) ^ ((pc >> 22) & 0xFF) ^ ((pc >> 32) & 0x7F)


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
    dut.lkp_path_sig.value = 0
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
async def loop_parity_error_invalidates_confident_override(dut):
    """A corrupted loop entry must miss instead of overriding direction."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_3000
    target = pc - 0x40
    trip_count = 8

    for _ in range(8):
        await drive_loop_trip(dut, pc, target, trip_count)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_path_sig.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1

    dut.test_corrupt_parity_pc.value = pc
    dut.test_corrupt_parity_path_sig.value = 0
    dut.test_corrupt_parity_valid.value = 1
    await RisingEdge(dut.clk)
    dut.test_corrupt_parity_valid.value = 0

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_path_sig.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0

    await drive_loop_trip(dut, pc, target, trip_count)
    dut.upd_valid.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0
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
    dut.lkp_path_sig.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    dut.lkp_valid.value = 0


@cocotb.test()
async def loop_tag_collision_does_not_detune_trained_entry(dut):
    """A different PC with the same folded loop tag must not reset a
    saturated loop entry's trip count or confidence."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    hot_pc = 0x8000_6000
    hot_target = hot_pc - 0x40

    for _ in range(8):
        await drive_loop_trip(dut, hot_pc, hot_target, 8)

    hot_tag = loop_tag(hot_pc)
    hot_sig = loop_pc_signature(hot_pc)
    alias_pc = None
    candidate = 0x8004_0000
    while candidate < 0x9000_0000:
        if loop_tag(candidate) == hot_tag and loop_pc_signature(candidate) != hot_sig:
            alias_pc = candidate
            break
        candidate += 4
    assert alias_pc is not None

    await drive_loop_trip(dut, alias_pc, alias_pc - 0x20, 3)

    dut.upd_valid.value = 0
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = hot_pc
    dut.lkp_path_sig.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    dut.lkp_valid.value = 0


@cocotb.test()
async def loop_path_signature_separates_nested_loop_contexts(dut):
    """The same loop branch reached under different path signatures should
    keep independent trip counts instead of detuning the hot context."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8000
    target = pc - 0x40

    for _ in range(8):
        await drive_loop_trip(dut, pc, target, 8, path_sig=0x12)
    for _ in range(8):
        await drive_loop_trip(dut, pc, target, 3, path_sig=0xA5)

    dut.upd_valid.value = 0
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_path_sig.value = 0x12
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1

    dut.lkp_path_sig.value = 0xA5
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    dut.lkp_valid.value = 0


@cocotb.test()
async def loop_single_early_exit_does_not_rewrite_saturated_bound(dut):
    """A one-off early exit should lower confidence but keep the learned
    trip count; one normal trip should recover saturated prediction."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_9000
    target = pc - 0x40

    for _ in range(8):
        await drive_loop_trip(dut, pc, target, 8, path_sig=0x34)

    await drive_loop_trip(dut, pc, target, 3, path_sig=0x34)
    await drive_loop_trip(dut, pc, target, 8, path_sig=0x34)

    dut.upd_valid.value = 0
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_path_sig.value = 0x34
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_taken.value) == 1
    dut.lkp_valid.value = 0
