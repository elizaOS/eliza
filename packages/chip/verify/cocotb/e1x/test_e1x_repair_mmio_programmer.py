from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

ADDR_CTRL = 0x00
ADDR_STATUS = 0x04
ADDR_DATA_LO = 0x08
ADDR_DATA_HI = 0x0C
ADDR_PUSH = 0x10
ADDR_COUNT = 0x14
MAGIC = 0x4531_5852_4550_4149


def route_word(logical_from: int, logical_to: int, direction: int, hops: int) -> int:
    return (logical_from << 40) | (logical_to << 19) | (direction << 16) | hops


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.mmio_write_valid.value = 0
    dut.mmio_write_addr.value = 0
    dut.mmio_write_data.value = 0
    dut.mmio_read_valid.value = 0
    dut.mmio_read_addr.value = 0
    dut.lookup_valid.value = 0
    dut.lookup_from.value = 0
    dut.lookup_to.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def mmio_write(dut, addr: int, data: int) -> None:
    dut.mmio_write_addr.value = addr
    dut.mmio_write_data.value = data
    await Timer(1, units="ns")
    while int(dut.mmio_write_ready.value) == 0:
        await RisingEdge(dut.clk)
    dut.mmio_write_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_write_valid.value = 0
    await Timer(1, units="ns")


async def mmio_read(dut, addr: int) -> int:
    dut.mmio_read_addr.value = addr
    dut.mmio_read_valid.value = 1
    await Timer(1, units="ns")
    assert int(dut.mmio_read_valid_out.value) == 1
    value = int(dut.mmio_read_data.value)
    dut.mmio_read_valid.value = 0
    return value


async def push_word(dut, word: int) -> None:
    await mmio_write(dut, ADDR_DATA_LO, word & 0xFFFF_FFFF)
    await mmio_write(dut, ADDR_DATA_HI, (word >> 32) & 0xFFFF_FFFF)
    await mmio_write(dut, ADDR_PUSH, 1)


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


async def load_programmed_rom(dut) -> None:
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
        await push_word(dut, word)
    for _ in range(3):
        await RisingEdge(dut.clk)
    await Timer(1, units="ns")


@cocotb.test()
async def repair_mmio_programmer_loads_route_table_and_serves_lookup(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await load_programmed_rom(dut)

    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 0
    assert int(dut.route_count.value) == 2
    assert int(dut.programmer_words_pushed.value) == 10
    assert await mmio_read(dut, ADDR_COUNT) == 10
    assert await lookup_route(dut, 10, 20) == (1, 1, 3)
    assert await lookup_route(dut, 11, 21) == (1, 2, 4)
    assert await lookup_route(dut, 12, 22) == (0, 7, 0)


@cocotb.test()
async def repair_mmio_programmer_reports_invalid_access_and_clear_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await mmio_write(dut, 0xFC, 0x1234)
    assert int(dut.programmer_error.value) == 1
    status = await mmio_read(dut, ADDR_STATUS)
    assert status & 0x4

    await mmio_write(dut, ADDR_CTRL, 0x2)
    assert int(dut.programmer_error.value) == 0

    await load_programmed_rom(dut)
    assert int(dut.route_count.value) == 2
    await mmio_write(dut, ADDR_CTRL, 0x1)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")

    assert int(dut.route_count.value) == 0
    assert int(dut.load_done.value) == 0
    assert int(dut.programmer_words_pushed.value) == 0
    assert await lookup_route(dut, 10, 20) == (0, 7, 0)
