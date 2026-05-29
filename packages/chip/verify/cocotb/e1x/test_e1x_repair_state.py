from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

MAGIC = 0x4531_5852_4550_4149


def remap_word(logical: int, physical: int) -> int:
    return (logical << 32) | physical


def route_word(logical_from: int, logical_to: int, direction: int, hops: int) -> int:
    return (logical_from << 40) | (logical_to << 19) | (direction << 16) | hops


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.word_valid.value = 0
    dut.word.value = 0
    dut.remap_lookup_valid.value = 0
    dut.remap_lookup_logical.value = 0
    dut.route_lookup_valid.value = 0
    dut.route_lookup_from.value = 0
    dut.route_lookup_to.value = 0
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


async def load_small_rom(dut) -> None:
    words = [
        MAGIC,
        (512 << 32) | 342,
        (528 << 32) | 358,
        0x3660,
        3,
        2,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        remap_word(13, 342),
        remap_word(40, 343),
        remap_word(48, 700),
        route_word(0, 1, 1, 1),
        route_word(342, 684, 2, 4),
    ]
    for word in words:
        await send_word(dut, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")


async def load_oversized_rom(dut) -> None:
    words = [
        MAGIC,
        (512 << 32) | 342,
        (528 << 32) | 358,
        0x3660,
        9,
        9,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        *[remap_word(100 + idx, 1000 + idx) for idx in range(9)],
        *[route_word(200 + idx, 300 + idx, 1 + (idx % 4), idx + 1) for idx in range(9)],
    ]
    for word in words:
        await send_word(dut, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")


async def lookup_remap(dut, logical: int) -> tuple[int, int]:
    dut.remap_lookup_logical.value = logical
    dut.remap_lookup_valid.value = 1
    await Timer(1, units="ns")
    hit = int(dut.remap_lookup_hit.value)
    physical = int(dut.remap_lookup_physical.value)
    dut.remap_lookup_valid.value = 0
    return hit, physical


async def lookup_route(dut, logical_from: int, logical_to: int) -> tuple[int, int, int]:
    dut.route_lookup_from.value = logical_from
    dut.route_lookup_to.value = logical_to
    dut.route_lookup_valid.value = 1
    await Timer(1, units="ns")
    hit = int(dut.route_lookup_hit.value)
    direction = int(dut.route_lookup_dir.value)
    hops = int(dut.route_lookup_hops.value)
    dut.route_lookup_valid.value = 0
    return hit, direction, hops


@cocotb.test()
async def repair_state_loads_rom_and_serves_remap_route_lookups(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await load_small_rom(dut)

    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 0
    assert int(dut.remap_count.value) == 3
    assert int(dut.route_count.value) == 2

    assert await lookup_remap(dut, 13) == (1, 342)
    assert await lookup_remap(dut, 40) == (1, 343)
    assert await lookup_remap(dut, 41) == (0, 41)
    assert await lookup_route(dut, 342, 684) == (1, 2, 4)
    assert await lookup_route(dut, 1, 2) == (0, 7, 0)


@cocotb.test()
async def repair_state_clear_removes_loaded_records(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await load_small_rom(dut)
    assert await lookup_remap(dut, 48) == (1, 700)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")

    assert int(dut.remap_count.value) == 0
    assert int(dut.route_count.value) == 0
    assert int(dut.overflow.value) == 0
    assert await lookup_remap(dut, 48) == (0, 48)
    assert int(dut.word_ready.value) == 1


@cocotb.test()
async def repair_state_flags_capacity_overflow_and_clear_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await load_oversized_rom(dut)

    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 1
    assert int(dut.remap_count.value) == 8
    assert int(dut.route_count.value) == 8
    assert await lookup_remap(dut, 100) == (1, 1000)
    assert await lookup_remap(dut, 108) == (0, 108)
    assert await lookup_route(dut, 207, 307) == (1, 4, 8)
    assert await lookup_route(dut, 208, 308) == (0, 7, 0)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")

    assert int(dut.overflow.value) == 0
    assert int(dut.remap_count.value) == 0
    assert int(dut.route_count.value) == 0
