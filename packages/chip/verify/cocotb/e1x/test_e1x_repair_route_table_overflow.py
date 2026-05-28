from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

MAGIC = 0x4531_5852_4550_4149


def route_word(logical_from: int, logical_to: int, direction: int, hops: int) -> int:
    return (logical_from << 40) | (logical_to << 19) | (direction << 16) | hops


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.word_valid.value = 0
    dut.word.value = 0
    dut.lookup_valid.value = 0
    dut.lookup_from.value = 0
    dut.lookup_to.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def send_word(dut, word: int) -> None:
    assert int(dut.word_ready.value) == 1
    dut.word.value = word
    dut.word_valid.value = 1
    await RisingEdge(dut.clk)
    dut.word_valid.value = 0
    await Timer(1, units="ns")


async def lookup_route(dut, logical_from: int, logical_to: int) -> tuple[int, int, int]:
    dut.lookup_from.value = logical_from
    dut.lookup_to.value = logical_to
    dut.lookup_valid.value = 1
    await Timer(1, units="ns")
    hit = int(dut.lookup_hit.value)
    direction = int(dut.lookup_dir.value)
    hops = int(dut.lookup_hops.value)
    dut.lookup_valid.value = 0
    return hit, direction, hops


@cocotb.test()
async def repair_route_table_flags_capacity_overflow_and_clear_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    words = [
        MAGIC,
        (512 << 32) | 342,
        (528 << 32) | 358,
        0x3660,
        0,
        2,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        route_word(10, 20, 1, 3),
        route_word(11, 21, 2, 4),
    ]
    for word in words:
        await send_word(dut, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")

    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 1
    assert int(dut.route_count.value) == 1
    assert await lookup_route(dut, 10, 20) == (1, 1, 3)
    assert await lookup_route(dut, 11, 21) == (0, 7, 0)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")

    assert int(dut.overflow.value) == 0
    assert int(dut.route_count.value) == 0
    assert int(dut.word_ready.value) == 1
