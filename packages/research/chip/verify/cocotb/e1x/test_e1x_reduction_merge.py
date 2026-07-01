from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

MASK32 = (1 << 32) - 1


def u32(value: int) -> int:
    return value & MASK32


def s32(value: int) -> int:
    value &= MASK32
    return value - (1 << 32) if value & (1 << 31) else value


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.cfg_valid.value = 0
    dut.cfg_group.value = 0
    dut.cfg_expected_count.value = 0
    dut.in_valid.value = 0
    dut.in_group.value = 0
    dut.in_payload.value = 0
    dut.out_ready.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def configure(dut, group: int, expected_count: int) -> None:
    dut.cfg_group.value = group
    dut.cfg_expected_count.value = expected_count
    dut.cfg_valid.value = 1
    for _ in range(8):
        await RisingEdge(dut.clk)
        if int(dut.cfg_ready.value):
            dut.cfg_valid.value = 0
            await RisingEdge(dut.clk)
            return
    raise AssertionError("reduction merge did not accept configuration")


async def send_partial(dut, group: int, payload: int) -> None:
    dut.in_group.value = group
    dut.in_payload.value = u32(payload)
    dut.in_valid.value = 1
    for _ in range(8):
        await RisingEdge(dut.clk)
        if int(dut.in_ready.value):
            dut.in_valid.value = 0
            await RisingEdge(dut.clk)
            return
    raise AssertionError("reduction merge did not accept input partial")


async def collect_output(dut, ready_delay: int = 0) -> tuple[int, int, int]:
    for _ in range(20):
        if int(dut.out_valid.value):
            break
        await RisingEdge(dut.clk)
    assert int(dut.out_valid.value), "reduction merge did not produce output"
    for _ in range(ready_delay):
        assert int(dut.out_valid.value), "output was not held under backpressure"
        assert not int(dut.cfg_ready.value), "new config accepted while output was backpressured"
        await RisingEdge(dut.clk)
    group = int(dut.out_group.value)
    payload = s32(int(dut.out_payload.value))
    overflow = int(dut.out_overflow.value)
    dut.out_ready.value = 1
    await RisingEdge(dut.clk)
    dut.out_ready.value = 0
    await RisingEdge(dut.clk)
    return group, payload, overflow


@cocotb.test()
async def sums_signed_partials_for_one_group(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await configure(dut, group=3, expected_count=4)
    for value in (12, -5, 7, -2):
        await send_partial(dut, 3, value)
    group, payload, overflow = await collect_output(dut)
    assert group == 3
    assert payload == 12
    assert overflow == 0
    assert int(dut.received_count.value) == 4


@cocotb.test()
async def holds_completed_result_until_ready(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await configure(dut, group=9, expected_count=2)
    await send_partial(dut, 9, 100)
    await send_partial(dut, 9, -40)
    group, payload, overflow = await collect_output(dut, ready_delay=5)
    assert (group, payload, overflow) == (9, 60, 0)
    assert int(dut.cfg_ready.value) == 1


@cocotb.test()
async def ignores_wrong_group_and_counts_mismatch(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await configure(dut, group=4, expected_count=2)
    await send_partial(dut, 5, 1000)
    assert int(dut.mismatch_count.value) == 1
    assert int(dut.received_count.value) == 0
    await send_partial(dut, 4, 11)
    await send_partial(dut, 4, 31)
    group, payload, overflow = await collect_output(dut)
    assert (group, payload, overflow) == (4, 42, 0)


@cocotb.test()
async def saturates_positive_and_negative_overflow(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await configure(dut, group=1, expected_count=2)
    await send_partial(dut, 1, 0x7FFF_FFFF)
    await send_partial(dut, 1, 1)
    group, payload, overflow = await collect_output(dut)
    assert group == 1
    assert payload == 0x7FFF_FFFF
    assert overflow == 1

    await configure(dut, group=2, expected_count=2)
    await send_partial(dut, 2, -0x8000_0000)
    await send_partial(dut, 2, -1)
    group, payload, overflow = await collect_output(dut)
    assert group == 2
    assert payload == -0x8000_0000
    assert overflow == 1


@cocotb.test()
async def rejects_zero_length_configuration(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.cfg_valid.value = 1
    dut.cfg_group.value = 7
    dut.cfg_expected_count.value = 0
    await RisingEdge(dut.clk)
    dut.cfg_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.cfg_error.value) == 1
    assert int(dut.active.value) == 0
    assert int(dut.cfg_ready.value) == 1
