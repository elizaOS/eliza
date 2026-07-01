"""Droop event injection + clock-stretcher response tests.

Contract:
  - droop_sensor.droop_alarm_o pulses when last_count_o drops below
    threshold_i for DROOP_CONFIRM_SAMPLES consecutive samples.
  - clock_stretcher.stretch_o pulses within one clk_in_i cycle of the alarm
    (CLKSTRETCH_CYCLES=1 in power_pkg).

See docs/pd/droop-detection.md for the contract narrative.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

CLK_SAMPLE_PERIOD_NS = 5  # 200 MHz
CLK_IN_PERIOD_NS = 4  # 250 MHz functional clock
RO_FAST_PERIOD_NS = 0.5  # high-frequency RO when supply is healthy (2 GHz)
RO_SLOW_PERIOD_NS = 5.0  # low-frequency RO when supply has drooped (200 MHz)


async def _reset_and_init(dut):
    dut.rst_n.value = 0
    dut.sample_tick_i.value = 0
    dut.enable_i.value = 0
    dut.threshold_i.value = 0
    dut.phase_select_i.value = 0
    for _ in range(10):
        await RisingEdge(dut.clk_sample)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk_sample)


async def _drive_sample_tick(dut, period_ratio=10):
    """Generate a 1-cycle sample_tick_i pulse every period_ratio cycles."""
    while True:
        for _ in range(period_ratio - 1):
            await RisingEdge(dut.clk_sample)
            dut.sample_tick_i.value = 0
        await RisingEdge(dut.clk_sample)
        dut.sample_tick_i.value = 1


@cocotb.test()
async def healthy_supply_holds_no_alarm(dut):
    """With RO clocking fast, droop_alarm must not assert."""
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_in, CLK_IN_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.ro_clk, RO_FAST_PERIOD_NS, units="ns").start())

    await _reset_and_init(dut)
    dut.threshold_i.value = 100  # require >= 100 RO cycles per sample window
    dut.enable_i.value = 1

    cocotb.start_soon(_drive_sample_tick(dut, period_ratio=10))

    # 200 sample periods at 200 MHz = 1 us of soak.
    for _ in range(2000):
        await RisingEdge(dut.clk_sample)
        if int(dut.droop_alarm.value) == 1:
            raise AssertionError("droop_alarm asserted under healthy supply")

    assert int(dut.droop_event_count.value) == 0
    assert int(dut.stretch_event_count.value) == 0


@cocotb.test()
async def drooped_supply_triggers_alarm_and_stretch(dut):
    """RO slowing below threshold for >=CONFIRM_SAMPLES triggers alarm + stretch."""
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_in, CLK_IN_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.ro_clk, RO_SLOW_PERIOD_NS, units="ns").start())

    await _reset_and_init(dut)
    dut.threshold_i.value = 100
    dut.enable_i.value = 1

    cocotb.start_soon(_drive_sample_tick(dut, period_ratio=10))

    alarm_seen = False
    stretch_seen = False
    for _ in range(4000):
        await RisingEdge(dut.clk_sample)
        if int(dut.droop_alarm.value) == 1:
            alarm_seen = True
        if int(dut.stretch_event_count.value) > 0:
            stretch_seen = True
        if alarm_seen and stretch_seen:
            break

    assert alarm_seen, "droop_alarm never asserted under simulated droop"
    assert stretch_seen, "clock_stretcher did not observe alarm"
    assert int(dut.droop_event_count.value) >= 1
    assert int(dut.stretch_event_count.value) >= 1


@cocotb.test()
async def disabled_sensor_holds_no_alarm(dut):
    """When enable_i is deasserted, no alarm and no stretch even under droop."""
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_in, CLK_IN_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.ro_clk, RO_SLOW_PERIOD_NS, units="ns").start())

    await _reset_and_init(dut)
    dut.threshold_i.value = 100
    dut.enable_i.value = 0

    cocotb.start_soon(_drive_sample_tick(dut, period_ratio=10))

    for _ in range(2000):
        await RisingEdge(dut.clk_sample)
        assert int(dut.droop_alarm.value) == 0, "alarm fired with enable_i=0"

    assert int(dut.droop_event_count.value) == 0
    assert int(dut.stretch_event_count.value) == 0
