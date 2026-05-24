"""L1I dual-demand miss bridge tests."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


async def reset(dut):
    dut.rst_n.value = 0
    dut.flush_i.value = 0
    dut.miss_valid_i.value = 0
    dut.miss_paddr_line_i.value = 0
    dut.miss_is_prefetch_i.value = 0
    dut.miss_valid_lane1_i.value = 0
    dut.miss_paddr_line_lane1_i.value = 0
    dut.miss_is_prefetch_lane1_i.value = 0
    dut.l2_l1i_acq_ready_i.value = 1
    dut.l2_l1i_grant_valid_i.value = 0
    dut.l2_l1i_grant_paddr_line_i.value = 0
    dut.l2_l1i_grant_data_i.value = 0
    dut.refill_ready_i.value = 1
    dut.refill_ready_lane1_i.value = 1
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for_high(dut, name, cycles=40):
    for _ in range(cycles):
        await Timer(1, units="ns")
        if int(getattr(dut, name).value) == 1:
            return
        await RisingEdge(dut.clk)
    raise AssertionError(f"{name} did not assert")


def line_payload(base: int) -> int:
    value = 0
    for beat in range(4):
        value |= (base + beat) << (beat * 128)
    return value


async def issue_grant_and_collect(dut, *, lane1: bool, base: int) -> list[int]:
    await wait_for_high(dut, "l2_l1i_acq_valid_o")
    dut.l2_l1i_grant_data_i.value = line_payload(base)
    dut.l2_l1i_grant_valid_i.value = 1
    await wait_for_high(dut, "l2_l1i_grant_ready_o")
    await RisingEdge(dut.clk)
    dut.l2_l1i_grant_valid_i.value = 0

    got = []
    for _ in range(20):
        await Timer(1, units="ns")
        valid = int(dut.refill_valid_lane1_o.value if lane1 else dut.refill_valid_o.value)
        if valid:
            got.append(int(dut.refill_data_lane1_o.value if lane1 else dut.refill_data_o.value))
            if int(dut.refill_last_lane1_o.value if lane1 else dut.refill_last_o.value):
                await RisingEdge(dut.clk)
                break
        await RisingEdge(dut.clk)
    return got


@cocotb.test()
async def lane1_miss_demuxes_l2_line_to_lane1_refill(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.miss_valid_lane1_i.value = 1
    dut.miss_paddr_line_lane1_i.value = 0x8000_4000
    await wait_for_high(dut, "miss_ready_lane1_o")
    await RisingEdge(dut.clk)
    dut.miss_valid_lane1_i.value = 0

    await wait_for_high(dut, "l2_l1i_acq_valid_o")
    assert int(dut.l2_l1i_acq_paddr_line_o.value) == 0x8000_4000
    assert int(dut.l2_l1i_acq_is_prefetch_o.value) == 0
    assert int(dut.active_lane1_o.value) == 1

    got = await issue_grant_and_collect(dut, lane1=True, base=0xABC0)
    assert got == [0xABC0, 0xABC1, 0xABC2, 0xABC3]
    assert int(dut.refill_valid_o.value) == 0


@cocotb.test()
async def scalar_miss_has_priority_and_lane1_waits_for_next_l2_transaction(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.miss_valid_i.value = 1
    dut.miss_paddr_line_i.value = 0x8000_0000
    dut.miss_is_prefetch_i.value = 1
    dut.miss_valid_lane1_i.value = 1
    dut.miss_paddr_line_lane1_i.value = 0x8000_8000
    await wait_for_high(dut, "miss_ready_o")
    await Timer(1, units="ns")
    assert int(dut.miss_ready_lane1_o.value) == 0
    await RisingEdge(dut.clk)
    dut.miss_valid_i.value = 0

    await wait_for_high(dut, "l2_l1i_acq_valid_o")
    assert int(dut.l2_l1i_acq_paddr_line_o.value) == 0x8000_0000
    assert int(dut.l2_l1i_acq_is_prefetch_o.value) == 1
    got0 = await issue_grant_and_collect(dut, lane1=False, base=0x1000)
    assert got0 == [0x1000, 0x1001, 0x1002, 0x1003]

    await wait_for_high(dut, "miss_ready_lane1_o")
    await RisingEdge(dut.clk)
    dut.miss_valid_lane1_i.value = 0

    await wait_for_high(dut, "l2_l1i_acq_valid_o")
    assert int(dut.l2_l1i_acq_paddr_line_o.value) == 0x8000_8000
    got1 = await issue_grant_and_collect(dut, lane1=True, base=0x2000)
    assert got1 == [0x2000, 0x2001, 0x2002, 0x2003]


@cocotb.test()
async def flush_drops_outstanding_dual_miss_transaction(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.miss_valid_lane1_i.value = 1
    dut.miss_paddr_line_lane1_i.value = 0x8000_C000
    await wait_for_high(dut, "miss_ready_lane1_o")
    await RisingEdge(dut.clk)
    dut.miss_valid_lane1_i.value = 0

    await wait_for_high(dut, "l2_l1i_acq_valid_o")
    dut.flush_i.value = 1
    await RisingEdge(dut.clk)
    dut.flush_i.value = 0
    await Timer(1, units="ns")
    assert int(dut.busy_o.value) == 0
    assert int(dut.l2_l1i_acq_valid_o.value) == 0
    assert int(dut.refill_valid_lane1_o.value) == 0
