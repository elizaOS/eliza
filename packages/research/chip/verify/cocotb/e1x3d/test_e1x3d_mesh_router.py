from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

PORTS = 7
COLORS = 24
DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_UP = 5
DIR_DOWN = 6
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
async def planar_color_route_still_forwards(dut):
    # Regression: the planar N->E route the 2D router proves must still hold on
    # the 7-port 3D instance.
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
async def local_to_up_route_forwards_to_upper_tier(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=9, in_port=DIR_LOCAL, out_port=DIR_UP)
    set_color(dut, DIR_LOCAL, 9)
    set_payload(dut, DIR_LOCAL, 0x00C0_FFEE)
    dut.in_valid.value = 1 << DIR_LOCAL
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_LOCAL)
    assert int(dut.out_valid.value) & (1 << DIR_UP)
    assert get_payload(dut, DIR_UP) == 0x00C0_FFEE
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def down_to_local_route_delivers_from_lower_tier(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=11, in_port=DIR_DOWN, out_port=DIR_LOCAL)
    set_color(dut, DIR_DOWN, 11)
    set_payload(dut, DIR_DOWN, 0x1357_9BDF)
    dut.in_valid.value = 1 << DIR_DOWN
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_DOWN)
    assert int(dut.out_valid.value) & (1 << DIR_LOCAL)
    assert get_payload(dut, DIR_LOCAL) == 0x1357_9BDF


@cocotb.test()
async def disabled_z_link_repair_drops_and_acknowledges(dut):
    # A dead inter-tier (UP) link under repair must drop-and-ack, not stall.
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=7, in_port=DIR_SOUTH, out_port=DIR_UP)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_UP
    set_color(dut, DIR_SOUTH, 7)
    set_payload(dut, DIR_SOUTH, 0xDEAD_BEEF)
    dut.in_valid.value = 1 << DIR_SOUTH
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_SOUTH)
    assert int(dut.repaired_drop.value) & (1 << DIR_SOUTH)
    assert (int(dut.out_valid.value) & (1 << DIR_UP)) == 0


@cocotb.test()
async def explicit_drop_route_is_visible_under_repair(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=5, in_port=DIR_DOWN, out_port=DIR_DROP)
    dut.repair_enable.value = 1
    set_color(dut, DIR_DOWN, 5)
    set_payload(dut, DIR_DOWN, 0x1234_5678)
    dut.in_valid.value = 1 << DIR_DOWN
    await settle()

    assert int(dut.in_ready.value) & (1 << DIR_DOWN)
    assert int(dut.repaired_drop.value) & (1 << DIR_DOWN)
    assert int(dut.out_valid.value) == 0
