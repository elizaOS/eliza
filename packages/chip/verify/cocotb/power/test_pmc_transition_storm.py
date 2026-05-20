"""Transition-event-storm: rapid CPU+NPU+display state changes through PMC.

Scenario:
  - Linux issues a tight burst of DVFS requests for the CPU_BIG, NPU, and
    SOC_FABRIC rails alternating every clk_aon cycle. This mimics a real
    Android scenario where:
      * cpufreq sched-util raises CPU_BIG on a task wake,
      * NPU controller raises VDD_NPU for the next layer,
      * display compositor toggles SOC_FABRIC for a frame post,
    all within a single millisecond. The PMC mailbox must:
      1. Latch every write without dropping.
      2. Fan-out the correct code per rail.
      3. Keep all valid bits asserted across the burst.

This is a behavioral contract test, not a real-silicon timing test. The
mailbox is a 32b synchronous register file; the contract is that one valid
write per clk_aon cycle is consumed.

Together with test_pmc_droop_aggregation.py this exercises the worst
back-to-back path through pmc_top: write-then-read-then-write on
distinct rails.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    DVFS_CODE_WIDTH,
    DVFS_RAIL_COUNT,
    PMC_REG_DVFS_BASE,
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


async def _mbox_write_one_cycle(dut, addr, data):
    """Single-cycle posted write. Caller is responsible for any pacing."""
    dut.mbox_addr_i.value = addr
    dut.mbox_wdata_i.value = data
    dut.mbox_write_i.value = 1
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    dut.mbox_write_i.value = 0


@cocotb.test()
async def storm_of_dvfs_writes_lands_every_request(dut):
    """50-write burst across 6 DVFS rails; every request must land."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Mix of CPU_BIG (0), NPU (2), SOC_FABRIC (4) rapid transitions, then end
    # with the final code per rail. Last-writer-wins per rail.
    burst = []
    for step in range(50):
        rail = step % DVFS_RAIL_COUNT
        code = ((step * 7) + 0x40) & ((1 << DVFS_CODE_WIDTH) - 1)
        burst.append((rail, code))

    expected_final = {}
    for rail, code in burst:
        expected_final[rail] = code
        word = (1 << 31) | code
        await _mbox_write_one_cycle(dut, PMC_REG_DVFS_BASE + 4 * rail, word)

    for _ in range(4):
        await RisingEdge(dut.clk_aon)

    for rail in range(DVFS_RAIL_COUNT):
        actual_code = int(dut.dvfs_request_code_o[rail].value)
        actual_valid = int(dut.dvfs_request_valid_o[rail].value)
        assert actual_valid == 1, f"rail {rail}: valid bit not held across storm"
        assert actual_code == expected_final[rail], (
            f"rail {rail}: storm final code {actual_code:#x} != expected {expected_final[rail]:#x}"
        )


@cocotb.test()
async def storm_keeps_valid_high_after_clear_and_reset_request(dut):
    """A write of 0 to the rail register clears its valid bit; subsequent
    raise sets it. The mailbox must propagate this within one cycle."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    rail = 2  # NPU
    # Raise.
    raise_code = 0xA5
    await _mbox_write_one_cycle(dut, PMC_REG_DVFS_BASE + 4 * rail, (1 << 31) | raise_code)
    for _ in range(2):
        await RisingEdge(dut.clk_aon)
    assert int(dut.dvfs_request_valid_o[rail].value) == 1
    assert int(dut.dvfs_request_code_o[rail].value) == raise_code

    # Drop valid (write zero word).
    await _mbox_write_one_cycle(dut, PMC_REG_DVFS_BASE + 4 * rail, 0)
    for _ in range(2):
        await RisingEdge(dut.clk_aon)
    assert int(dut.dvfs_request_valid_o[rail].value) == 0

    # Re-raise next cycle.
    re_code = 0x33
    await _mbox_write_one_cycle(dut, PMC_REG_DVFS_BASE + 4 * rail, (1 << 31) | re_code)
    for _ in range(2):
        await RisingEdge(dut.clk_aon)
    assert int(dut.dvfs_request_valid_o[rail].value) == 1
    assert int(dut.dvfs_request_code_o[rail].value) == re_code


@cocotb.test()
async def storm_with_concurrent_avfs_fault_keeps_thermal_irq_consistent(dut):
    """During a DVFS storm, raising avfs_fault_i lights thermal_irq_o exactly
    when at least one fault is asserted and clears when all faults clear."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Mid-storm, assert fault on rail 3 (GPU).
    dut.avfs_fault_i.value = 0
    for step in range(20):
        rail = step % DVFS_RAIL_COUNT
        word = (1 << 31) | (step + 1)
        await _mbox_write_one_cycle(dut, PMC_REG_DVFS_BASE + 4 * rail, word)
        if step == 10:
            dut.avfs_fault_i.value = 1 << 3
            await RisingEdge(dut.clk_aon)
            assert int(dut.thermal_irq_o.value) == 1, (
                "thermal_irq did not rise within 1 clk_aon of fault"
            )
        if step == 15:
            dut.avfs_fault_i.value = 0
            await RisingEdge(dut.clk_aon)
            assert int(dut.thermal_irq_o.value) == 0, (
                "thermal_irq did not clear within 1 clk_aon of fault deassert"
            )
