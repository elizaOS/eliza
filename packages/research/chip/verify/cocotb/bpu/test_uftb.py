"""Cocotb unit tests for the uFTB (zero-bubble next-line predictor)."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

FETCH_BLOCK_OFF_W = 5
UFTB_IDX_W = 7
UFTB_WAYS = 4


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_next_pc.value = 0
    dut.upd_fall_through_pc.value = 0
    dut.upd_kind.value = 0
    dut.test_corrupt_parity_valid.value = 0
    dut.test_corrupt_parity_idx.value = 0
    dut.test_corrupt_parity_way.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def train(dut, pc, nxt, kind, fall_through=None):
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_next_pc.value = nxt
    dut.upd_fall_through_pc.value = (pc + 4) if fall_through is None else fall_through
    dut.upd_kind.value = kind
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0


async def lookup(dut, pc):
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    hit = int(dut.lkp_hit.value)
    nxt = int(dut.lkp_next_pc.value)
    fall_through = int(dut.lkp_fall_through_pc.value)
    kind = int(dut.lkp_kind.value)
    conf = int(dut.lkp_conf.value)
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
    return hit, nxt, fall_through, kind, conf


def uftb_same_set_pc(pc, salt):
    return pc ^ (1 << (FETCH_BLOCK_OFF_W + UFTB_IDX_W + salt))


def uftb_index(pc):
    return (pc >> FETCH_BLOCK_OFF_W) & ((1 << UFTB_IDX_W) - 1)


@cocotb.test()
async def uftb_cold_read_returns_pc_plus_block(dut):
    """A cold lookup must produce the fallthrough PC + 32 B and lkp_hit=0."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_0000
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0
    assert int(dut.lkp_next_pc.value) == pc + 32
    assert int(dut.lkp_fall_through_pc.value) == pc + 32
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def uftb_train_and_hit(dut):
    """After a stored upd_next_pc, the same lookup should return that."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8000
    nxt = 0x8001_0000
    fall_through = pc + 4

    await train(dut, pc, nxt, 1, fall_through=fall_through)
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_next_pc.value) == nxt
    assert int(dut.lkp_fall_through_pc.value) == fall_through
    assert int(dut.lkp_kind.value) == 1
    assert int(dut.lkp_conf.value) == 1
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def uftb_same_cycle_lookup_update_forwards_write(dut):
    """Same-cycle lookup/update forwards the new target deterministically."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    cold_pc = 0x8000_8800
    cold_next = 0x8001_8800
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = cold_pc
    dut.upd_valid.value = 1
    dut.upd_pc.value = cold_pc
    dut.upd_next_pc.value = cold_next
    dut.upd_fall_through_pc.value = cold_pc + 4
    dut.upd_kind.value = 2
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_next_pc.value) == cold_next
    assert int(dut.lkp_kind.value) == 2
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
    dut.upd_valid.value = 0

    pc = 0x8000_8A00
    old_next = 0x8001_8A00
    new_next = 0x8001_8C00
    await train(dut, pc, old_next, 1)
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_next_pc.value = new_next
    dut.upd_fall_through_pc.value = pc + 8
    dut.upd_kind.value = 4
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_next_pc.value) == new_next
    assert int(dut.lkp_fall_through_pc.value) == pc + 8
    assert int(dut.lkp_kind.value) == 4
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
    dut.upd_valid.value = 0


@cocotb.test()
async def uftb_nonzero_offset_branch_hits_block_lookup(dut):
    """Resolved branch PCs inside a block must train the block-PC uFTB entry."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    block_pc = 0x8000_9000
    branch_pc = block_pc + 0x18
    nxt = 0x8001_4000
    fall_through = branch_pc + 4

    for _ in range(3):
        await train(dut, branch_pc, nxt, 2, fall_through=fall_through)

    hit, got_next, got_fall_through, kind, conf = await lookup(dut, block_pc)
    assert hit == 1
    assert got_next == nxt
    assert got_fall_through == fall_through
    assert kind == 2
    assert conf == 3


@cocotb.test()
async def uftb_replacement_preserves_recently_used_way(dut):
    """A hot uFTB entry should survive same-set allocation churn."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    base = 0x8000_A000
    pcs = [base] + [uftb_same_set_pc(base, salt) for salt in range(4)]
    targets = [0x8001_0000 + i * 0x40 for i in range(len(pcs))]

    for pc, target in zip(pcs[:4], targets[:4], strict=False):
        await train(dut, pc, target, 1)

    hit, nxt, _, _, _ = await lookup(dut, pcs[0])
    assert hit == 1
    assert nxt == targets[0]

    await train(dut, pcs[4], targets[4], 1)

    hit, nxt, _, _, _ = await lookup(dut, pcs[0])
    assert hit == 1
    assert nxt == targets[0]

    hit, _, _, _, _ = await lookup(dut, pcs[1])
    assert hit == 0


@cocotb.test()
async def uftb_updates_kind_and_confidence(dut):
    """Repeated matching updates should strengthen confidence; changed kind
    should be reflected immediately and reset confidence to weak."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_A000
    nxt = 0x8001_2000

    for _ in range(4):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_next_pc.value = nxt
        dut.upd_fall_through_pc.value = pc + 4
        dut.upd_kind.value = 2
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_kind.value) == 2
    assert int(dut.lkp_conf.value) == 3
    dut.lkp_valid.value = 0

    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_next_pc.value = nxt + 0x40
    dut.upd_fall_through_pc.value = pc + 8
    dut.upd_kind.value = 4
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_next_pc.value) == nxt + 0x40
    assert int(dut.lkp_fall_through_pc.value) == pc + 8
    assert int(dut.lkp_kind.value) == 4
    assert int(dut.lkp_conf.value) == 1
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def uftb_parity_error_invalidates_entry(dut):
    """A corrupt uFTB payload must miss and invalidate instead of steering."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_C000
    nxt = 0x8001_C000
    await train(dut, pc, nxt, 1)
    await RisingEdge(dut.clk)

    idx = uftb_index(pc)
    way = UFTB_WAYS - 1
    dut.test_corrupt_parity_idx.value = idx
    dut.test_corrupt_parity_way.value = way
    dut.test_corrupt_parity_valid.value = 1
    await RisingEdge(dut.clk)
    dut.test_corrupt_parity_valid.value = 0

    hit, got_next, _, _, _ = await lookup(dut, pc)
    assert hit == 0
    assert got_next == pc + 32
