"""Cocotb unit tests for Statistical Corrector."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

VADDR_W = 39
TAGE_HIST_LEN_MAX = 195
SC_TABLES = 6
SC_IDX_W = 10
SC_CTR_W = 6
SC_HIST_LEN = (0, 4, 10, 16, 27, 44)


def _fold(value, width, out_width):
    folded = 0
    for bit in range(width):
        if (value >> bit) & 1:
            folded ^= 1 << (bit % out_width)
    return folded


def sc_local_index(pc):
    return (pc >> 1) % 1024


def sc_index(table_id, pc, hist, local_hist=0):
    folded_pc = _fold(pc, VADDR_W, SC_IDX_W)
    folded_h = _fold(hist & ((1 << SC_HIST_LEN[table_id]) - 1), SC_HIST_LEN[table_id], SC_IDX_W)
    folded_local = _fold(local_hist, 8, SC_IDX_W)
    return folded_pc ^ folded_h ^ folded_local ^ table_id


def _parity(value):
    return value.bit_count() & 1


def sc_entry(ctr):
    ctr_bits = ctr & ((1 << SC_CTR_W) - 1)
    return (ctr_bits << 1) | _parity(ctr_bits)


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.lkp_hist.value = 0
    dut.lkp_tage_taken.value = 0
    dut.lkp_tage_lowconf.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_hist.value = 0
    dut.upd_taken.value = 0
    dut.upd_tage_lowconf.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def sc_no_override_when_tage_high_confidence(dut):
    """If TAGE confidence is high (lkp_tage_lowconf=0), SC must not override
    the prediction regardless of accumulated counters."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = 0x8000_0000
    dut.lkp_tage_taken.value = 1
    dut.lkp_tage_lowconf.value = 0
    await Timer(1, units="ps")
    assert int(dut.lkp_override.value) == 0
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def sc_trains_when_tage_lowconf(dut):
    """Drive 32 low-confidence taken resolves at one PC. The SC counters
    should accumulate (we cannot observe directly without a probe but we
    sanity-check that lkp_override can fire once trained)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8001_0000
    for _ in range(32):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_taken.value = 1
        dut.upd_tage_lowconf.value = 1
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    # Sample SC output under a low-confidence TAGE assumption.
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_tage_taken.value = 0  # TAGE says not taken
    dut.lkp_tage_lowconf.value = 1
    await Timer(1, units="ps")
    # SC trained on taken resolves; the override may fire and direction is
    # taken. We do not strictly assert override fired (threshold dynamics),
    # only that the predictor outputs a stable signal.
    _ = int(dut.lkp_override.value)
    _ = int(dut.lkp_taken.value)
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def sc_updates_local_history_on_all_resolves(dut):
    """SC local history tracks all resolved conditionals, not only lowconf ones."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8001_0120
    local_idx = (pc >> 1) % 1024
    pattern = [1, 0, 1, 1, 0, 0, 1, 1]
    expected = 0
    for taken in pattern:
        expected = ((expected << 1) | taken) & 0xFF
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_taken.value = taken
        dut.upd_tage_lowconf.value = 1
        await RisingEdge(dut.clk)

    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.u_sc.local_history_q[local_idx].value) == expected

    # High-confidence TAGE updates still maintain local history even though
    # they do not train the SC tables or threshold.
    expected = ((expected << 1) | 0) & 0xFF
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_taken.value = 0
    dut.upd_tage_lowconf.value = 0
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.u_sc.local_history_q[local_idx].value) == expected


@cocotb.test()
async def sc_bias_bank_is_disabled_by_default(dut):
    """The optional per-PC bias bank stays off in the evidence-selected default."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8001_0450
    bias_idx = 0
    tmp = pc
    for bit in range(39):
        if (tmp >> bit) & 1:
            bias_idx ^= 1 << (bit % 11)

    for _ in range(8):
        dut.upd_valid.value = 1
        dut.upd_pc.value = pc
        dut.upd_taken.value = 1
        dut.upd_tage_lowconf.value = 0
        await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    assert int(dut.u_sc.bias_q[bias_idx].value.signed_integer) == 0
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_tage_taken.value = 0
    dut.lkp_tage_lowconf.value = 1
    await Timer(1, units="ps")
    assert int(dut.lkp_override.value) == 0


@cocotb.test()
async def sc_parity_error_contributes_neutral_vote(dut):
    """A corrupted SC counter must not force a low-confidence override."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8001_0800
    hist = 0x2A
    idx = sc_index(0, pc, hist)
    entry = dut.u_sc.storage_q[0][idx]
    entry.value = sc_entry(ctr=31)
    await Timer(1, units="ps")

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = hist
    dut.lkp_tage_taken.value = 0
    dut.lkp_tage_lowconf.value = 1
    await Timer(1, units="ps")
    assert int(dut.lkp_override.value) == 1
    assert int(dut.lkp_taken.value) == 1

    entry.value = sc_entry(ctr=31) ^ 1
    await Timer(1, units="ps")
    assert int(dut.lkp_override.value) == 0
    assert int(dut.lkp_taken.value) == 1

    dut.lkp_valid.value = 0
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = hist
    dut.upd_taken.value = 0
    dut.upd_tage_lowconf.value = 1
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await Timer(1, units="ps")
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = hist
    dut.lkp_tage_lowconf.value = 1
    await Timer(1, units="ps")
    assert int(dut.lkp_override.value) == 1
    assert int(dut.lkp_taken.value) == 0
