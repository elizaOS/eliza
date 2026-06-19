"""Multi-droop-source aggregation through PMC.

Scenario:
  - 4 simultaneous droop events on CPU_BIG, CPU_LITTLE, NPU, SOC_FABRIC
    rails (rails 0/1/2/4). The PMC mailbox aggregates the per-rail counters
    into PMC_REG_DROOP_COUNT, which the AON Ibex firmware reads to drive
    thermal_policy + avfs_arbiter responses.
  - The sum must equal the bitwise sum of all six droop_event_count_i bytes
    (rails 3 and 5 contribute zero in this test).
  - Aggregation must update across multiple sample periods without loss.

This sanity-checks the AVFS telemetry path:
   per-rail droop_sensor.droop_event_count_o -> PMC.droop_event_count_i ->
   PMC_REG_DROOP_COUNT (mailbox read).
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    DVFS_RAIL_COUNT,
    PMC_REG_DROOP_COUNT,
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


async def _mbox_read(dut, addr):
    dut.mbox_addr_i.value = addr
    dut.mbox_write_i.value = 0
    dut.mbox_valid_i.value = 1
    await RisingEdge(dut.clk_aon)
    dut.mbox_valid_i.value = 0
    await RisingEdge(dut.clk_aon)
    return int(dut.mbox_rdata_o.value)


async def _let_aggregate_settle(dut, cycles=8):
    for _ in range(cycles):
        await RisingEdge(dut.clk_sample)
    for _ in range(4):
        await RisingEdge(dut.clk_aon)


@cocotb.test()
async def four_simultaneous_droops_aggregate(dut):
    """4 simultaneous droops (CPU_BIG=2, CPU_LITTLE=3, NPU=5, SOC_FABRIC=7),
    GPU=0, SRAM=0. Aggregate must = 17."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    per_rail = [2, 3, 5, 0, 7, 0]  # 6 rails: CPU_BIG, CPU_LITTLE, NPU, GPU, SOC_FABRIC, SRAM
    for i, v in enumerate(per_rail):
        dut.droop_event_count_i[i].value = v

    await _let_aggregate_settle(dut)
    rb = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
    assert rb == sum(per_rail), f"aggregate mismatch: got {rb}, expected {sum(per_rail)}"


@cocotb.test()
async def aggregate_updates_across_multiple_sample_periods(dut):
    """Per-rail counters can change between samples; aggregate must follow
    without sample loss within sample-period granularity."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    sequences = [
        [1, 0, 0, 0, 0, 0],
        [1, 2, 0, 0, 0, 0],
        [1, 2, 3, 0, 0, 0],
        [1, 2, 3, 4, 0, 0],
        [1, 2, 3, 4, 5, 0],
        [1, 2, 3, 4, 5, 6],
    ]
    for seq in sequences:
        for i, v in enumerate(seq):
            dut.droop_event_count_i[i].value = v
        await _let_aggregate_settle(dut, cycles=8)
        rb = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
        assert rb == sum(seq), f"sequence {seq}: aggregate {rb} != expected {sum(seq)}"


@cocotb.test()
async def four_droops_with_concurrent_dvfs_storm(dut):
    """Stress: keep aggregation correct while DVFS storm + AVFS fault fire."""
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    per_rail = [11, 13, 17, 0, 19, 0]
    expected = sum(per_rail)
    for i, v in enumerate(per_rail):
        dut.droop_event_count_i[i].value = v
    dut.avfs_fault_i.value = (1 << 2) | (1 << 4)  # NPU + SOC_FABRIC faults

    # Drive ~10 background DVFS writes from the mailbox during settle.
    from cocotb.triggers import Timer

    async def writer():
        for step in range(10):
            rail = step % DVFS_RAIL_COUNT
            dut.mbox_addr_i.value = 0x040 + 4 * rail
            dut.mbox_wdata_i.value = (1 << 31) | ((step * 11) & 0xFF)
            dut.mbox_write_i.value = 1
            dut.mbox_valid_i.value = 1
            await RisingEdge(dut.clk_aon)
            dut.mbox_valid_i.value = 0
            dut.mbox_write_i.value = 0
            await Timer(10, units="ns")

    cocotb.start_soon(writer())
    await _let_aggregate_settle(dut, cycles=64)
    rb = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
    assert rb == expected, f"aggregate under storm/fault: got {rb}, expected {expected}"
    # thermal_irq must be set since avfs_fault is non-zero.
    assert int(dut.thermal_irq_o.value) == 1
