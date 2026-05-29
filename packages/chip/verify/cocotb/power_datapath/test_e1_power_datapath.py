"""Power-delivery datapath integration smoke.

Proves the power-datapath-not-integrated blocker is fixed: the four power leaf
cells (droop_sensor, clock_stretcher, avfs_ctrl, dldo) are now instantiated as a
closed per-rail loop by e1_power_datapath (wired into e1_soc_integrated), and
their telemetry is real instead of constant zero. The test arms the loop and
observes (1) droop alarms firing and counting, (2) the clock stretcher
responding to droop, (3) the dLDO regulating, and (4) the AVFS controller
lowering its DVFS code when the canary margin is healthy.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

RAIL_COUNT = 6
CANARY_BITS = 16
ALL_RAILS = (1 << RAIL_COUNT) - 1
CANARY_ALL_HIGH = (1 << CANARY_BITS) - 1


def _pack_rails(value, width):
    """Pack the same per-rail value into a flat RAIL_COUNT*width bus."""
    packed = 0
    for r in range(RAIL_COUNT):
        packed |= (value & ((1 << width) - 1)) << (r * width)
    return packed


async def reset(dut):
    cocotb.start_soon(Clock(dut.clk_sample, 5, units="ns").start())
    # RO clock runs slower than the sample clock so the per-window count stays
    # well below the droop threshold -> deterministic droop alarms.
    cocotb.start_soon(Clock(dut.ro_clk_i, 40, units="ns").start())
    dut.rst_n.value = 0
    dut.droop_enable_i.value = 0
    dut.avfs_enable_i.value = 0
    dut.dldo_enable_i.value = 0
    dut.clk_stretch_enable_i.value = 0
    dut.canary_margin_low_i.value = 0
    dut.canary_margin_high_i.value = _pack_rails(CANARY_ALL_HIGH, CANARY_BITS)
    await Timer(20, units="ns")
    dut.rst_n.value = 1
    await RisingEdge(dut.clk_sample)


def rail_field(value, rail, width):
    return (int(value) >> (rail * width)) & ((1 << width) - 1)


@cocotb.test()
async def droop_loop_fires_and_counts(dut):
    """Droop sensor raises alarms and the event counter advances."""
    await reset(dut)
    dut.droop_enable_i.value = ALL_RAILS
    dut.clk_stretch_enable_i.value = ALL_RAILS

    saw_alarm = False
    for _ in range(400):
        await RisingEdge(dut.clk_sample)
        if int(dut.droop_alarm_o.value) & 1:
            saw_alarm = True
            break
    assert saw_alarm, "droop_alarm never fired -> droop_sensor not in the loop"

    # Let several alarms accumulate and confirm the per-rail event counter ran.
    for _ in range(400):
        await RisingEdge(dut.clk_sample)
    evt0 = rail_field(dut.droop_event_count_o.value, 0, 32)
    assert evt0 > 0, f"droop_event_count[0]={evt0}, expected > 0"


@cocotb.test()
async def clock_stretcher_responds_to_droop(dut):
    """The clock stretcher asserts stretch_active in response to droop alarms."""
    await reset(dut)
    dut.droop_enable_i.value = ALL_RAILS
    dut.clk_stretch_enable_i.value = ALL_RAILS

    saw_stretch = False
    for _ in range(800):
        await RisingEdge(dut.clk_sample)
        if int(dut.stretch_active_o.value) & 1:
            saw_stretch = True
            break
    assert saw_stretch, "stretch_active never asserted -> clock_stretcher not wired"


@cocotb.test()
async def dldo_regulates_when_enabled(dut):
    """The dLDO reports regulating once enabled with a healthy Vout sample."""
    await reset(dut)
    dut.dldo_enable_i.value = ALL_RAILS

    saw_regulating = False
    for _ in range(200):
        await RisingEdge(dut.clk_sample)
        if int(dut.dldo_regulating_o.value) & 1:
            saw_regulating = True
            break
    assert saw_regulating, "dldo_regulating never asserted -> dldo not in the loop"


@cocotb.test()
async def avfs_lowers_code_on_healthy_margin(dut):
    """With all-high canary margin the AVFS controller lowers its DVFS code."""
    await reset(dut)
    dut.avfs_enable_i.value = ALL_RAILS
    dut.canary_margin_high_i.value = _pack_rails(CANARY_ALL_HIGH, CANARY_BITS)
    dut.canary_margin_low_i.value = 0

    init_code = rail_field(dut.avfs_target_code_o.value, 0, 8)
    lowered = False
    for _ in range(1000):
        await RisingEdge(dut.clk_sample)
        code = rail_field(dut.avfs_target_code_o.value, 0, 8)
        if code < init_code:
            lowered = True
            break
    assert lowered, (
        f"AVFS target_code stayed at {init_code:#x} -> avfs_ctrl not adjusting"
    )
    lower_count = rail_field(dut.avfs_lower_count_o.value, 0, 32)
    assert lower_count > 0, f"avfs_lower_count[0]={lower_count}, expected > 0"
