"""AVFS controller convergence tests under synthetic canary stimulus.

Contract:
  - target_code_o raises by 1 LSB per AVFS update when any canary reports
    low margin.
  - target_code_o lowers by 1 LSB per update when all canaries report high
    margin AND none report low margin.
  - Output clamps at [min_code_i, max_code_i].
  - fault_o asserts when controller would raise above max_code_i.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    AVFS_CANARY_COUNT,
    AVFS_UPDATE_CYCLES,
)

CLK_SAMPLE_PERIOD_NS = 5  # 200 MHz


async def _reset_and_init(dut, init_code=0x40, min_code=0x20, max_code=0xC0):
    dut.rst_n.value = 0
    dut.enable_i.value = 0
    dut.sample_tick_i.value = 0
    dut.canary_margin_low_i.value = 0
    dut.canary_margin_high_i.value = 0
    dut.min_code_i.value = min_code
    dut.max_code_i.value = max_code
    dut.init_code_i.value = init_code
    for _ in range(8):
        await RisingEdge(dut.clk_sample)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk_sample)


async def _run_updates(dut, num_updates, canary_low_mask, canary_high_mask):
    """Tick clk_sample enough cycles to land num_updates AVFS updates."""
    dut.canary_margin_low_i.value = canary_low_mask
    dut.canary_margin_high_i.value = canary_high_mask
    dut.enable_i.value = 1
    # AVFS update fires once per AVFS_UPDATE_CYCLES sample ticks.
    target_pulses = num_updates
    seen = 0
    cycle = 0
    while seen < target_pulses and cycle < AVFS_UPDATE_CYCLES * num_updates * 4:
        # Drive sample_tick every cycle (continuous 200 MHz tick).
        dut.sample_tick_i.value = 1
        await RisingEdge(dut.clk_sample)
        cycle += 1
        if int(dut.target_update_pulse_o.value) == 1:
            seen += 1
    dut.sample_tick_i.value = 0
    return seen


@cocotb.test()
async def avfs_raises_under_low_margin(dut):
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset_and_init(dut)
    start = int(dut.target_code_o.value)

    # Single canary reports low margin -> 4 updates raise by 4 LSB.
    ran = await _run_updates(dut, num_updates=4, canary_low_mask=0x1, canary_high_mask=0)
    assert ran == 4
    end = int(dut.target_code_o.value)
    assert end == start + 4, f"AVFS raise failed: start={start} end={end}"
    assert int(dut.fault_o.value) == 0


@cocotb.test()
async def avfs_lowers_when_all_canary_high(dut):
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset_and_init(dut, init_code=0x60)
    start = int(dut.target_code_o.value)
    full_high = (1 << AVFS_CANARY_COUNT) - 1
    ran = await _run_updates(dut, num_updates=3, canary_low_mask=0, canary_high_mask=full_high)
    assert ran == 3
    end = int(dut.target_code_o.value)
    assert end == start - 3, f"AVFS lower failed: start={start} end={end}"


@cocotb.test()
async def avfs_clamps_at_max_and_raises_fault(dut):
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset_and_init(dut, init_code=0xBE, min_code=0x20, max_code=0xC0)
    # First update raises 0xBE -> 0xBF; second to 0xC0 (max); third saturates.
    ran = await _run_updates(dut, num_updates=3, canary_low_mask=0x1, canary_high_mask=0)
    assert ran == 3
    assert int(dut.target_code_o.value) == 0xC0
    assert int(dut.fault_o.value) == 1


@cocotb.test()
async def avfs_clamps_at_min(dut):
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset_and_init(dut, init_code=0x22, min_code=0x20, max_code=0xC0)
    full_high = (1 << AVFS_CANARY_COUNT) - 1
    ran = await _run_updates(dut, num_updates=5, canary_low_mask=0, canary_high_mask=full_high)
    assert ran == 5
    assert int(dut.target_code_o.value) == 0x20
    assert int(dut.fault_o.value) == 0


@cocotb.test()
async def avfs_disabled_holds_init(dut):
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset_and_init(dut, init_code=0x80)
    # Drive canary low but leave enable_i=0.
    dut.canary_margin_low_i.value = 0xFFFF
    dut.canary_margin_high_i.value = 0
    dut.enable_i.value = 0
    for _ in range(AVFS_UPDATE_CYCLES * 4):
        dut.sample_tick_i.value = 1
        await RisingEdge(dut.clk_sample)
    assert int(dut.target_code_o.value) == 0x80
    assert int(dut.raise_event_count_o.value) == 0
    assert int(dut.lower_event_count_o.value) == 0
