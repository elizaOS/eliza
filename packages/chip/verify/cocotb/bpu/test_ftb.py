"""Cocotb unit tests for the FTB.

Covers:
  * cold read returns lkp_hit=0, pmu_miss=1
  * after upd_alloc, a re-read at the same PC produces lkp_hit=1 and the
    stored target/kind
  * two branches in the same fetch block occupy distinct branch slots
  * a non-matching PC still misses
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

BR_NONE, BR_COND, BR_CALL, BR_RET = 0, 1, 2, 3
FETCH_BLOCK_OFF_W = 5
MAX_BR_PER_BLOCK = 2
VADDR_W = 39
FETCH_BLOCK_BYTES = 32
FTB_ENTRIES = 4096
FTB_WAYS = 4
FTB_SETS = FTB_ENTRIES // FTB_WAYS
FTB_IDX_W = 10
FTB_TAG_W = 19


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_target.value = 0
    dut.upd_fall_through_pc.value = 0
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


def packed_slot(value, slot, width):
    raw = int(value)
    return (raw >> (slot * width)) & ((1 << width) - 1)


def ftb_index(pc):
    low = (pc >> FETCH_BLOCK_OFF_W) & ((1 << FTB_IDX_W) - 1)
    high_shift = FETCH_BLOCK_OFF_W + FTB_IDX_W + FTB_TAG_W - FTB_IDX_W
    high = (pc >> high_shift) & ((1 << FTB_IDX_W) - 1)
    return (low ^ high) % FTB_SETS


def ftb_tag(pc):
    return (pc >> (FETCH_BLOCK_OFF_W + FTB_IDX_W)) & ((1 << FTB_TAG_W) - 1)


def colliding_block_pcs(count, target_index=0):
    pcs = []
    seen_tags = set()
    for block in range(1 << 20):
        pc = block * FETCH_BLOCK_BYTES
        tag = ftb_tag(pc)
        if ftb_index(pc) == target_index and tag not in seen_tags:
            pcs.append(pc)
            seen_tags.add(tag)
            if len(pcs) == count:
                return pcs
    raise AssertionError("could not find enough FTB index collisions")


async def update(dut, pc, target, kind, alloc, fall_through_pc=None):
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_target.value = target
    dut.upd_fall_through_pc.value = pc + 4 if fall_through_pc is None else fall_through_pc
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
async def ftb_two_slots_same_fetch_block_hit(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    block_pc = 0x8000_6000
    cond_pc = block_pc + 0x18
    call_pc = block_pc + 0x04
    cond_target = 0x8000_7000
    call_target = 0x8000_6800

    await update(dut, cond_pc, cond_target, BR_COND, alloc=True)
    await update(dut, call_pc, call_target, BR_CALL, alloc=True, fall_through_pc=call_pc + 4)
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = block_pc
    await Timer(1, units="ps")
    hit = int(dut.lkp_hit.value)
    got_target = int(dut.lkp_target.value)
    got_kind = int(dut.lkp_kind.value)
    got_br_valid = int(dut.lkp_br_valid.value)
    offsets = int(dut.lkp_slot_offset.value)
    kinds = int(dut.lkp_slot_kind.value)
    targets = int(dut.lkp_slot_target.value)
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0

    assert hit == 1
    assert got_br_valid == 0b11

    # Scalar compatibility output reports the earliest branch offset in the
    # block, while the slot metadata preserves both learned branches.
    assert got_target == call_target
    assert got_kind == BR_CALL

    assert {
        (
            packed_slot(offsets, slot, FETCH_BLOCK_OFF_W),
            packed_slot(kinds, slot, 3),
            packed_slot(targets, slot, VADDR_W),
        )
        for slot in range(MAX_BR_PER_BLOCK)
    } == {
        (0x18, BR_COND, cond_target),
        (0x04, BR_CALL, call_target),
    }


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


@cocotb.test()
async def ftb_replacement_preserves_recently_used_way(dut):
    """When a set is full, allocation should evict the oldest way, not a hot
    way that was just hit."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pcs = colliding_block_pcs(FTB_WAYS + 1, target_index=7)
    targets = [0x9000_0000 + i * 0x100 for i in range(len(pcs))]

    for pc, target in zip(pcs[:FTB_WAYS], targets[:FTB_WAYS], strict=True):
        await update(dut, pc, target, BR_COND, alloc=True)
    await RisingEdge(dut.clk)

    hot_pc = pcs[0]
    evict_pc = pcs[1]
    hit, target, _kind = await lookup(dut, hot_pc)
    assert hit == 1
    assert target == targets[0]

    await update(dut, pcs[FTB_WAYS], targets[FTB_WAYS], BR_COND, alloc=True)
    await RisingEdge(dut.clk)

    hit, target, _kind = await lookup(dut, hot_pc)
    assert hit == 1
    assert target == targets[0]

    hit, _target, _kind = await lookup(dut, evict_pc)
    assert hit == 0

    hit, target, _kind = await lookup(dut, pcs[FTB_WAYS])
    assert hit == 1
    assert target == targets[FTB_WAYS]
