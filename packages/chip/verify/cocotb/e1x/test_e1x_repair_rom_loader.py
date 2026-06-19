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


@cocotb.test()
async def repair_rom_loader_decodes_header_remaps_and_routes(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    words = [
        MAGIC,
        (512 << 32) | 342,
        (528 << 32) | 358,
        0x3660,
        2,
        2,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        remap_word(13, 342),
        remap_word(40, 343),
        route_word(0, 1, 1, 1),
        route_word(342, 684, 2, 4),
    ]

    observed_remaps = []
    observed_routes = []
    for word in words:
        await send_word(dut, word)
        if int(dut.header_valid.value):
            assert int(dut.remap_count.value) == 2
            assert int(dut.route_count.value) == 2
        if int(dut.remap_valid.value):
            observed_remaps.append((int(dut.remap_logical.value), int(dut.remap_physical.value)))
        if int(dut.route_valid.value):
            observed_routes.append(
                (
                    int(dut.route_logical_from.value),
                    int(dut.route_logical_to.value),
                    int(dut.route_dir.value),
                    int(dut.route_hops.value),
                )
            )

    assert int(dut.done.value) == 1
    assert int(dut.error.value) == 0
    assert int(dut.words_seen.value) == len(words)
    assert observed_remaps == [(13, 342), (40, 343)]
    assert observed_routes == [(0, 1, 1, 1), (342, 684, 2, 4)]


@cocotb.test()
async def repair_rom_loader_rejects_bad_magic_and_clear_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await send_word(dut, 0xBAD0)
    assert int(dut.error.value) == 1
    assert int(dut.word_ready.value) == 0

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")

    assert int(dut.error.value) == 0
    assert int(dut.word_ready.value) == 1
    await send_word(dut, MAGIC)
    assert int(dut.error.value) == 0
