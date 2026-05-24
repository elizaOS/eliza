"""Cocotb unit tests for TAGE direction predictor.

Drives small synthetic resolve sequences and verifies that:
  * cold state: lkp_provider == 0 (bimodal-only)
  * after many same-direction resolves at one PC, the bimodal converges
  * tagged tables can be allocated on misprediction
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

VADDR_W = 39
TAGE_TAG_W = 8
TAGE_CTR_W = 3
TAGE_ENTRIES_TABLE = 8192
TAGE_IDX_W = 13
TAGE_HIST_LEN_MAX = 195
TAGE_HIST_LEN = (8, 16, 44, 90, 195)
TAGE_ALT_ON_NA_ENTRIES = 1024
TAGE_ALT_ON_NA_IDX_W = 10


def _fold(value, width, out_width):
    folded = 0
    for bit in range(width):
        if (value >> bit) & 1:
            folded ^= 1 << (bit % out_width)
    return folded


def tage_index(table_id, pc, hist):
    hist_len = TAGE_HIST_LEN[table_id]
    hist_mask = (1 << hist_len) - 1
    hist_slice = hist & hist_mask
    folded_pc = _fold(pc, VADDR_W, TAGE_IDX_W)
    folded_h = _fold(hist_slice, hist_len, TAGE_IDX_W)
    return folded_pc ^ folded_h ^ table_id


def tage_tag(table_id, pc, hist):
    hist_len = TAGE_HIST_LEN[table_id]
    hist_mask = (1 << hist_len) - 1
    hist_slice = hist & hist_mask
    folded_pc = _fold(pc, VADDR_W, TAGE_TAG_W)
    folded_h = _fold(hist_slice, hist_len, TAGE_TAG_W)
    rotated_h = ((folded_h & ((1 << (TAGE_TAG_W - 1)) - 1)) << 1) | (folded_h >> (TAGE_TAG_W - 1))
    return folded_pc ^ rotated_h ^ table_id


def alt_on_na_index(pc, provider):
    return ((pc >> 2) ^ (provider * 131)) & (TAGE_ALT_ON_NA_ENTRIES - 1)


def tage_entry(valid, tag, ctr, useful):
    return (
        (valid << (TAGE_TAG_W + TAGE_CTR_W + 2)) | (tag << (TAGE_CTR_W + 2)) | (ctr << 2) | useful
    )


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
    dut.upd_provider_taken.value = 0
    dut.upd_alt_taken.value = 0
    dut.upd_provider_weak.value = 0
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
    in one of the tagged tables. The allocation policy reads useful bits at
    the update hash; the test observes pmu_alloc strobing."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8000
    alloc_seen = False
    for _ in range(8):
        # Keep the lookup path live while the update-side allocation walker
        # searches for a useful==0 victim.
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


@cocotb.test()
async def tage_adaptive_use_alt_on_na_learns_alternate(dut):
    """A weak provider should yield to alternate after the chooser learns it."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8900
    hist = 0xA5
    alt_table = 0
    provider_table = 1
    provider = provider_table + 1

    alt_idx = tage_index(alt_table, pc, hist)
    alt_tag = tage_tag(alt_table, pc, hist)
    provider_idx = tage_index(provider_table, pc, hist)
    provider_tag = tage_tag(provider_table, pc, hist)
    chooser_idx = alt_on_na_index(pc, provider)

    alt_entry = dut.u_tage.g_tab[alt_table].u_tab.storage_q[alt_idx]
    provider_entry = dut.u_tage.g_tab[provider_table].u_tab.storage_q[provider_idx]

    alt_entry.value = tage_entry(valid=1, tag=alt_tag, ctr=0, useful=1)
    provider_entry.value = tage_entry(
        valid=1, tag=provider_tag, ctr=1 << (TAGE_CTR_W - 1), useful=0
    )
    dut.u_tage.alt_on_na_q[chooser_idx].value = 0
    await Timer(1, units="ps")

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = hist
    await Timer(1, units="ps")
    assert int(dut.lkp_provider.value) == provider
    assert int(dut.lkp_taken.value) == 1
    assert int(dut.lkp_taken_alt.value) == 0

    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = hist
    dut.upd_taken.value = 0
    dut.upd_misp.value = 0
    dut.upd_provider.value = provider
    dut.upd_provider_taken.value = 1
    dut.upd_alt_taken.value = 0
    dut.upd_provider_weak.value = 1
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    dut.upd_provider_weak.value = 0
    await Timer(1, units="ps")
    assert int(dut.u_tage.alt_on_na_q[chooser_idx].value.signed_integer) == 1

    # Keep the provider newly allocated and weak so the chooser decision is
    # what changes the prediction, not ordinary counter training.
    provider_entry.value = tage_entry(
        valid=1, tag=provider_tag, ctr=1 << (TAGE_CTR_W - 1), useful=0
    )
    await Timer(1, units="ps")

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = hist
    await Timer(1, units="ps")
    assert int(dut.lkp_provider.value) == provider
    assert int(dut.lkp_taken_alt.value) == 0
    assert int(dut.lkp_taken.value) == 0


@cocotb.test()
async def tage_allocation_pressure_decrements_useful_victims(dut):
    """If every longer table is useful, a miss must age candidate victims.

    This is the production TAGE escape hatch for allocation starvation: a
    repeatedly mispredicted branch should eventually make room instead of
    getting stuck behind permanently useful entries.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8A00
    hist = 0x5A

    entries = []
    for table in range(5):
        idx = tage_index(table, pc, hist)
        tag = tage_tag(table, pc, hist)
        entry = dut.u_tage.g_tab[table].u_tab.storage_q[idx]
        entry.value = tage_entry(valid=1, tag=tag, ctr=0, useful=3)
        entries.append(entry)
    await Timer(1, units="ps")

    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = hist
    dut.upd_taken.value = 1
    dut.upd_misp.value = 1
    dut.upd_provider.value = 0
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await Timer(1, units="ps")

    for entry in entries:
        assert int(entry.value) & 0b11 == 2
    assert int(dut.pmu_alloc.value) == 0


@cocotb.test()
async def tage_useful_reset_strobes_age_lsb_then_msb(dut):
    """The useful reset strobes age entries one bit at a time."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8B00
    hist = 0xC3
    table = 0
    idx = tage_index(table, pc, hist)
    tag = tage_tag(table, pc, hist)
    entry = dut.u_tage.g_tab[table].u_tab.storage_q[idx]
    entry.value = tage_entry(valid=1, tag=tag, ctr=7, useful=3)
    await Timer(1, units="ps")

    dut.useful_reset_lsb.value = 1
    await RisingEdge(dut.clk)
    dut.useful_reset_lsb.value = 0
    await Timer(1, units="ps")
    assert int(entry.value) & 0b11 == 2

    dut.useful_reset_msb.value = 1
    await RisingEdge(dut.clk)
    dut.useful_reset_msb.value = 0
    await Timer(1, units="ps")
    assert int(entry.value) & 0b11 == 0
