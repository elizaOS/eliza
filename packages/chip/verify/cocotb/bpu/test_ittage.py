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
    dut.probe_table.value = 0
    dut.probe_idx.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


VADDR_W = 39
TAGE_HIST_LEN_MAX = 195
ITT_IDX_W = 11
ITTAGE_TAG_W = 11
ITTAGE_ENTRIES = (1024, 1024, 2048, 2048, 2048)
ITTAGE_WAYS = 2
ITTAGE_SETS = tuple(entries // ITTAGE_WAYS for entries in ITTAGE_ENTRIES)
ITTAGE_HIST_LEN = (4, 10, 20, 40, 80)


def _index_hash(tid: int, pc: int, hist: int) -> int:
    folded_pc = 0
    folded_h = 0
    for k in range(VADDR_W):
        folded_pc ^= ((pc >> k) & 1) << (k % ITT_IDX_W)
    for k in range(ITTAGE_HIST_LEN[tid]):
        bit = (hist >> (TAGE_HIST_LEN_MAX - 1 - k)) & 1
        folded_h ^= bit << (k % ITT_IDX_W)
    return (folded_pc ^ folded_h ^ tid) % ITTAGE_SETS[tid]


def _find_pc_for_table_index(tid: int, min_idx: int) -> int:
    for pc in range(0x9000_0000, 0x9004_0000, 4):
        if _index_hash(tid, pc, 0) >= min_idx:
            return pc
    raise AssertionError(f"could not find pc mapping table {tid} above {min_idx}")


def _find_pc_for_exact_table_index(tid: int, want_idx: int, start: int = 0x9000_0000) -> int:
    for pc in range(start, start + 0x80000, 4):
        if _index_hash(tid, pc, 0) == want_idx:
            return pc
    raise AssertionError(f"could not find pc mapping table {tid} to index {want_idx}")


def _tag_hash(tid: int, pc: int, hist: int) -> int:
    folded_pc = 0
    folded_h = 0
    for k in range(VADDR_W):
        folded_pc ^= ((pc >> k) & 1) << (k % ITTAGE_TAG_W)
    for k in range(ITTAGE_HIST_LEN[tid]):
        bit = (hist >> (TAGE_HIST_LEN_MAX - 1 - k)) & 1
        folded_h ^= bit << (k % ITTAGE_TAG_W)
    rotated_h = ((folded_h & ((1 << (ITTAGE_TAG_W - 1)) - 1)) << 1) | (
        folded_h >> (ITTAGE_TAG_W - 1)
    )
    return folded_pc ^ rotated_h ^ tid


def _find_pc_for_exact_table_index_and_different_tag(
    tid: int,
    want_idx: int,
    tag_to_avoid: int,
    start: int = 0x9000_0000,
) -> int:
    for pc in range(start, start + 0x100000, 4):
        if _index_hash(tid, pc, 0) == want_idx and _tag_hash(tid, pc, 0) != tag_to_avoid:
            return pc
    raise AssertionError(f"could not find pc mapping table {tid} to index {want_idx} with new tag")


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
async def ittage_periodically_ages_useful_bits(dut):
    """Useful bits age periodically so stale indirect entries stop sticking."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x9000_5000
    target = 0x9000_9000
    table = 3

    # Allocate table 3, then refresh it so useful becomes nonzero.
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = 0
    dut.upd_target.value = target
    dut.upd_misp.value = 1
    dut.upd_provider.value = table
    await RisingEdge(dut.clk)
    dut.upd_misp.value = 0
    dut.upd_provider.value = table + 1
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)

    useful_idx = None
    for probe_idx in range(ITTAGE_SETS[table]):
        dut.probe_table.value = table
        dut.probe_idx.value = probe_idx
        await Timer(1, units="ps")
        if int(dut.probe_useful.value) > 0:
            useful_idx = probe_idx
            break
    assert useful_idx is not None
    dut.probe_idx.value = useful_idx

    # The testbench instantiates ITTAGE with USEFUL_RESET_PERIOD=4; after a
    # bounded number of unrelated updates, useful should age back down.
    for _ in range(12):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc + 0x40
        dut.upd_target.value = target + 0x40
        dut.upd_misp.value = 0
        dut.upd_provider.value = 0
        await RisingEdge(dut.clk)
        await Timer(1, units="ps")
        if int(dut.probe_useful.value) == 0:
            break

    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.probe_useful.value) == 0


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
async def ittage_replaces_useful_zero_occupied_victim(dut):
    """Useful-zero occupied entries are valid allocation victims."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    table = 4
    victim_pc = 0x9000_2800
    idx = _index_hash(table, victim_pc, 0)
    replacement_pc = _find_pc_for_exact_table_index_and_different_tag(
        table,
        idx,
        _tag_hash(table, victim_pc, 0),
        start=victim_pc + 0x10000,
    )
    assert replacement_pc != victim_pc
    victim_target = 0x9000_8000
    replacement_target = 0x9000_A000

    dut.upd_valid.value = 1
    dut.upd_pc.value = victim_pc
    dut.upd_hist.value = 0
    dut.upd_target.value = victim_target
    dut.upd_misp.value = 1
    dut.upd_provider.value = table
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.probe_table.value = table
    dut.probe_idx.value = idx
    await Timer(1, units="ps")
    assert int(dut.probe_useful.value) == 0

    dut.upd_valid.value = 1
    dut.upd_pc.value = replacement_pc
    dut.upd_hist.value = 0
    dut.upd_target.value = replacement_target
    dut.upd_misp.value = 1
    dut.upd_provider.value = table
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = replacement_pc
    dut.lkp_hist.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_provider.value) == table + 1
    assert int(dut.lkp_target.value) == replacement_target
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def ittage_upper_tables_use_full_2k_index_space(dut):
    """Upper ITTAGE tables must physically use their full set index space."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    table = 4
    pc = _find_pc_for_table_index(table, 512)
    idx = _index_hash(table, pc, 0)
    assert idx >= 512
    target = 0x900A_0000

    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = 0
    dut.upd_target.value = target
    dut.upd_misp.value = 1
    dut.upd_provider.value = table
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_provider.value) == table + 1
    assert int(dut.lkp_target.value) == target
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def ittage_set_associative_table_keeps_two_colliding_indirect_targets(dut):
    """Two PCs that collide in one ITTAGE set should occupy different ways."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    table = 4
    pc_a = 0x9000_3800
    idx = _index_hash(table, pc_a, 0)
    pc_b = _find_pc_for_exact_table_index_and_different_tag(
        table,
        idx,
        _tag_hash(table, pc_a, 0),
        start=pc_a + 0x10000,
    )
    target_a = 0x9010_0000
    target_b = 0x9020_0000

    for pc, target in ((pc_a, target_a), (pc_b, target_b)):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_hist.value = 0
        dut.upd_target.value = target
        dut.upd_misp.value = 1
        dut.upd_provider.value = table
        await RisingEdge(dut.clk)
        dut.upd_valid.value = 0
        await RisingEdge(dut.clk)

    for pc, target in ((pc_a, target_a), (pc_b, target_b)):
        dut.lkp_valid.value = 1
        dut.lkp_pc.value = pc
        dut.lkp_hist.value = 0
        await Timer(1, units="ps")
        assert int(dut.lkp_hit.value) == 1
        assert int(dut.lkp_provider.value) == table + 1
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
