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


def set_repair_dir(dut, port: int, direction: int) -> None:
    flat = getattr(dut, "_repair_dir_shadow", 0)
    shift = port * 3
    mask = 0b111 << shift
    flat = (flat & ~mask) | ((direction & 0b111) << shift)
    dut._repair_dir_shadow = flat
    dut.repair_route_dir_flat.value = flat


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
    dut.repair_route_hit.value = 0
    dut._route_table_shadow = 0
    dut._repair_dir_shadow = 0
    dut._in_color_shadow = 0
    dut._in_payload_shadow = 0
    dut.route_table_flat.value = 0
    dut.repair_route_dir_flat.value = 0
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
async def repair_route_override_steers_around_disabled_default_output(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=6, in_port=DIR_WEST, out_port=DIR_EAST)
    set_repair_dir(dut, DIR_WEST, DIR_SOUTH)
    set_color(dut, DIR_WEST, 6)
    set_payload(dut, DIR_WEST, 0x5150_600D)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_EAST
    dut.repair_route_hit.value = 1 << DIR_WEST
    dut.in_valid.value = 1 << DIR_WEST
    await settle()

    assert int(dut.repair_override_used.value) & (1 << DIR_WEST)
    assert int(dut.in_ready.value) & (1 << DIR_WEST)
    assert int(dut.out_valid.value) & (1 << DIR_SOUTH)
    assert get_payload(dut, DIR_SOUTH) == 0x5150_600D
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def repair_route_override_is_ignored_when_repair_disabled(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    set_route(dut, color=4, in_port=DIR_WEST, out_port=DIR_EAST)
    set_repair_dir(dut, DIR_WEST, DIR_SOUTH)
    set_color(dut, DIR_WEST, 4)
    set_payload(dut, DIR_WEST, 0xA5A5_1001)
    dut.port_disable.value = 1 << DIR_EAST
    dut.repair_route_hit.value = 1 << DIR_WEST
    dut.in_valid.value = 1 << DIR_WEST
    await settle()

    assert int(dut.repair_override_used.value) == 0
    assert int(dut.in_ready.value) == 0
    assert int(dut.out_valid.value) == 0
    assert int(dut.repaired_drop.value) == 0
