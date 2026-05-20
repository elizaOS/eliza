"""PMC mailbox + DVFS request fan-out cocotb tests.

Contract:
  - Mailbox write to PMC_REG_DVFS_BASE + 4*N pushes the bottom DVFS_CODE_WIDTH
    bits into dvfs_request_code_o[N], and bit 31 of the write into
    dvfs_request_valid_o[N].
  - Mailbox write to PMC_REG_CTRL is read-back identical.
  - Mailbox read of PMC_REG_DROOP_COUNT returns the sum of per-rail counters.
  - thermal_irq_o asserts when any avfs_fault_i is high.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge
from power_pkg_constants import (
    DVFS_CODE_WIDTH,
    DVFS_RAIL_COUNT,
    PMC_REG_AVFS_STATUS,
    PMC_REG_CTRL,
    PMC_REG_DROOP_COUNT,
    PMC_REG_DVFS_BASE,
)

CLK_AON_PERIOD_NS = 30  # ~32 kHz divided & boosted on AON PLL — abstracted here
CLK_SAMPLE_PERIOD_NS = 5  # 200 MHz


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


@cocotb.test()
async def ctrl_reg_readback(dut):
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)
    pattern = 0xCAFEBABE
    await _mbox_write(dut, PMC_REG_CTRL, pattern)
    rb = await _mbox_read(dut, PMC_REG_CTRL)
    assert rb == pattern, f"PMC_REG_CTRL readback mismatch: wrote {pattern:#x} read {rb:#x}"


@cocotb.test()
async def dvfs_request_fanout_per_rail(dut):
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    expected_codes = []
    for rail in range(DVFS_RAIL_COUNT):
        code = (0x10 + rail) & ((1 << DVFS_CODE_WIDTH) - 1)
        word = (1 << 31) | code  # valid + code
        await _mbox_write(dut, PMC_REG_DVFS_BASE + 4 * rail, word)
        expected_codes.append(code)

    # Allow signals to settle.
    for _ in range(4):
        await RisingEdge(dut.clk_aon)

    for rail in range(DVFS_RAIL_COUNT):
        actual_code = int(dut.dvfs_request_code_o[rail].value)
        actual_valid = int(dut.dvfs_request_valid_o[rail].value)
        assert actual_valid == 1, f"rail {rail}: valid not asserted"
        assert actual_code == expected_codes[rail], (
            f"rail {rail}: expected code {expected_codes[rail]:#x} got {actual_code:#x}"
        )


@cocotb.test()
async def droop_count_aggregates_rails(dut):
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)

    values = [5, 7, 11, 13, 17, 19]
    total = sum(values)
    for i, v in enumerate(values):
        dut.droop_event_count_i[i].value = v

    # Wait at least one clk_sample period for the aggregator FF to update.
    for _ in range(8):
        await RisingEdge(dut.clk_sample)
    for _ in range(4):
        await RisingEdge(dut.clk_aon)

    rb = await _mbox_read(dut, PMC_REG_DROOP_COUNT)
    assert rb == total, f"droop aggregate mismatch: expected {total}, got {rb}"


@cocotb.test()
async def avfs_fault_lights_thermal_irq(dut):
    cocotb.start_soon(Clock(dut.clk_aon, CLK_AON_PERIOD_NS, units="ns").start())
    cocotb.start_soon(Clock(dut.clk_sample, CLK_SAMPLE_PERIOD_NS, units="ns").start())
    await _reset(dut)
    # No faults initially.
    assert int(dut.thermal_irq_o.value) == 0
    dut.avfs_fault_i.value = 1 << 2  # NPU fault
    for _ in range(4):
        await RisingEdge(dut.clk_aon)
    assert int(dut.thermal_irq_o.value) == 1
    rb = await _mbox_read(dut, PMC_REG_AVFS_STATUS)
    assert (rb & 0x3F) == (1 << 2), f"AVFS status mismatch: {rb:#x}"
