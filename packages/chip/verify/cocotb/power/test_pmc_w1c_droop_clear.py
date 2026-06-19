"""Write-1-to-clear semantics for the PMC sticky droop counter.

Contract:
  - PMC_REG_DROOP_STICKY accumulates the rising delta of the per-rail droop
    event counters (rtl/power/pmc_top.sv ``droop_sticky_q``).
  - A mailbox write to PMC_REG_DROOP_STICKY is a W1C mask: the bits that are
    1 in mbox_wdata clear the matching bits of the sticky counter.
  - A full-clear (0xFFFFFFFF) returns the counter to zero.
  - After a full clear, subsequent droop events resume accumulation from zero.

Together with test_pmc_droop_aggregation.py this exercises both the
running-aggregate read at PMC_REG_DROOP_COUNT and the sticky-counter drain
path that firmware uses to keep state across thermal-policy ticks.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    DVFS_RAIL_COUNT,
    PMC_REG_DROOP_COUNT,
    PMC_REG_DROOP_STICKY,
)

CLK_AON_PERIOD_NS = 30
CLK_SAMPLE_PERIOD_NS = 5


async def _reset(dut):
    dut.rst_n.value = 0
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    dut.mbox_addr_i.value = 0
    dut.mbox_wdata_i.value = 0
    dut.droop_alarm_i.value = 0
    for i in range(DVFS_RAIL_COUNT):
        dut.droop_event_count_i[i].value = 0
        dut.avfs_target_code_i[i].value = 0
        dut.avfs_raise_count_i[i].value = 0
        dut.avfs_lower_count_i[i].value = 0
    dut.avfs_fault_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk_aon)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk_aon)


async def _mbox_write(dut, addr, data):
    dut.mbox_addr_i.value = addr
    dut.mbox_wdata_i.value = data
    dut.mbox_write_i.value = 1
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0
    await RisingEdge(dut.clk_aon)


async def _mbox_read(dut, addr):
    dut.mbox_addr_i.value = addr
    dut.mbox_write_i.value = 0
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    await RisingEdge(dut.clk_aon)
    return int(dut.mbox_rdata_o.value)


async def _settle(dut, n=12):
    for _ in range(n):
        await RisingEdge(dut.clk_sample)
    for _ in range(4):
        await RisingEdge(dut.clk_aon)


@cocotb.test()
async def sticky_counter_accumulates_then_full_clear(dut):
    """Drive a rising per-rail counter sum, observe the sticky aggregate,
    full-clear it, and confirm the sticky reads as zero afterwards."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Start with zero counts so the sticky is 0.
    await _settle(dut, n=8)
    initial = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert initial == 0, f"sticky did not reset to 0: {initial}"

    # First step: bring the per-rail sum from 0 -> 10.
    counts_a = [1, 2, 3, 0, 4, 0]
    for i, v in enumerate(counts_a):
        dut.droop_event_count_i[i].value = v
    await _settle(dut)
    after_a = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert after_a == sum(counts_a), (
        f"sticky did not accumulate: got {after_a}, expected {sum(counts_a)}"
    )

    # Second step: bring the per-rail sum from 10 -> 25 (delta +15).
    counts_b = [4, 5, 6, 0, 10, 0]
    for i, v in enumerate(counts_b):
        dut.droop_event_count_i[i].value = v
    await _settle(dut)
    after_b = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert after_b == sum(counts_b), (
        f"sticky aggregate after second step: got {after_b}, expected {sum(counts_b)}"
    )

    # Full clear.
    await _mbox_write(dut, PMC_REG_DROOP_STICKY, 0xFFFFFFFF)
    await _settle(dut)
    after_clear = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert after_clear == 0, f"sticky did not clear: got {after_clear}"


@cocotb.test()
async def w1c_only_clears_the_specified_bits(dut):
    """Write-1-to-clear only affects the bits set in the mask. Lower 4 bits
    cleared; upper bits must survive."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Bring sticky to a known value > 0x0F.
    counts = [0, 0, 0, 0, 0, 0x10]  # +16
    for i, v in enumerate(counts):
        dut.droop_event_count_i[i].value = v
    await _settle(dut)
    before = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert before == 0x10, f"sticky setup mismatch: got {before:#x}"

    # Write mask 0x0F: only clears bottom 4 bits, top bits untouched.
    await _mbox_write(dut, PMC_REG_DROOP_STICKY, 0x0000000F)
    await _settle(dut)
    after = await _mbox_read(dut, PMC_REG_DROOP_STICKY)
    assert after == (0x10 & ~0x0F), f"partial W1C: expected {(0x10 & ~0x0F):#x}, got {after:#x}"


@cocotb.test()
async def droop_count_aggregate_still_reads_present_sum(dut):
    """Sanity: PMC_REG_DROOP_COUNT continues to return the present per-rail
    sum independent of the sticky counter."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    counts = [3, 5, 7, 11, 13, 17]
    for i, v in enumerate(counts):
        dut.droop_event_count_i[i].value = v
    await _settle(dut, n=10)
    present = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
    assert present == sum(counts), f"present sum mismatch: {present} != {sum(counts)}"

    # Clear the sticky; present sum is unaffected.
    await _mbox_write(dut, PMC_REG_DROOP_STICKY, 0xFFFFFFFF)
    await _settle(dut)
    present_after_clear = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
    assert present_after_clear == sum(counts), (
        f"present sum changed after sticky clear: {present_after_clear} != {sum(counts)}"
    )
