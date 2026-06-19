from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

PORTS = 5
COLORS = 24
DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_DROP = 7
COLOR_BITS = 5
PAYLOAD_BITS = 32


def set_route(dut, color: int, in_port: int, out_port: int) -> None:
    flat = getattr(dut, "_route_table_shadow", 0)
    shift = (color * PORTS + in_port) * 3
    mask = 0b111 << shift
    flat = (flat & ~mask) | ((out_port & 0b111) << shift)
    dut._route_table_shadow = flat
    dut.route_table_flat.value = flat


def set_color(dut, port: int, color: int) -> None:
    flat = getattr(dut, "_in_color_shadow", 0)
    shift = port * COLOR_BITS
    mask = ((1 << COLOR_BITS) - 1) << shift
    flat = (flat & ~mask) | ((color & ((1 << COLOR_BITS) - 1)) << shift)
    dut._in_color_shadow = flat
    dut.in_color_flat.value = flat


def set_payload(dut, port: int, payload: int) -> None:
    flat = getattr(dut, "_in_payload_shadow", 0)
    shift = port * PAYLOAD_BITS
    mask = ((1 << PAYLOAD_BITS) - 1) << shift
    flat = (flat & ~mask) | ((payload & ((1 << PAYLOAD_BITS) - 1)) << shift)
    dut._in_payload_shadow = flat
    dut.in_payload_flat.value = flat


def get_payload(dut, port: int) -> int:
    flat = int(dut.out_payload_flat.value)
    shift = port * PAYLOAD_BITS
    return (flat >> shift) & ((1 << PAYLOAD_BITS) - 1)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.repair_enable.value = 0
    dut.port_disable.value = 0
    dut._route_table_shadow = 0
    dut._in_color_shadow = 0
    dut._in_payload_shadow = 0
    dut.route_table_flat.value = 0
    dut.in_valid.value = 0
    dut.in_color_flat.value = 0
    dut.in_payload_flat.value = 0
    for _ in range(2):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def settle() -> None:
    await Timer(1, units="ns")


@cocotb.test()
async def color_route_forwards_payload_to_programmed_port(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=3, in_port=DIR_NORTH, out_port=DIR_EAST)
    set_color(dut, DIR_NORTH, 3)
    set_payload(dut, DIR_NORTH, 0xCAFE_1234)
    dut.in_valid.value = 1 << DIR_NORTH
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_NORTH)
    assert int(dut.out_valid.value) & (1 << DIR_EAST)
    assert get_payload(dut, DIR_EAST) == 0xCAFE_1234
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def disabled_output_link_repair_drops_and_acknowledges(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=7, in_port=DIR_WEST, out_port=DIR_EAST)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_EAST
    set_color(dut, DIR_WEST, 7)
    set_payload(dut, DIR_WEST, 0xDEAD_BEEF)
    dut.in_valid.value = 1 << DIR_WEST
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_WEST)
    assert int(dut.repaired_drop.value) & (1 << DIR_WEST)
    assert (int(dut.out_valid.value) & (1 << DIR_EAST)) == 0


@cocotb.test()
async def disabled_input_link_repair_drops_before_forwarding(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=2, in_port=DIR_SOUTH, out_port=DIR_LOCAL)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_SOUTH
    set_color(dut, DIR_SOUTH, 2)
    set_payload(dut, DIR_SOUTH, 0x1111_2222)
    dut.in_valid.value = 1 << DIR_SOUTH
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_SOUTH)
    assert int(dut.repaired_drop.value) & (1 << DIR_SOUTH)
    assert int(dut.out_valid.value) == 0


@cocotb.test()
async def contention_keeps_later_input_backpressured(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for port in range(PORTS):
        set_route(dut, color=1, in_port=port, out_port=DIR_LOCAL)
        set_color(dut, port, 1)
    set_payload(dut, DIR_NORTH, 0xAAAA_0001)
    set_payload(dut, DIR_EAST, 0xBBBB_0002)
    dut.in_valid.value = (1 << DIR_NORTH) | (1 << DIR_EAST)
    await settle()

    out_valid = int(dut.out_valid.value)
    in_ready = int(dut.in_ready.value)
    repaired_drop = int(dut.repaired_drop.value)

    assert out_valid & (1 << DIR_LOCAL), f"out_valid={out_valid:#x}"
    assert in_ready & (1 << DIR_NORTH), f"in_ready={in_ready:#x}"
    assert (in_ready & (1 << DIR_EAST)) == 0, f"in_ready={in_ready:#x}"
    assert repaired_drop == 0, f"repaired_drop={repaired_drop:#x}"


@cocotb.test()
async def explicit_drop_route_is_visible_under_repair(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=5, in_port=DIR_LOCAL, out_port=DIR_DROP)
    dut.repair_enable.value = 1
    set_color(dut, DIR_LOCAL, 5)
    set_payload(dut, DIR_LOCAL, 0x1234_5678)
    dut.in_valid.value = 1 << DIR_LOCAL
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_LOCAL)
    assert int(dut.repaired_drop.value) & (1 << DIR_LOCAL)
    assert int(dut.out_valid.value) == 0
