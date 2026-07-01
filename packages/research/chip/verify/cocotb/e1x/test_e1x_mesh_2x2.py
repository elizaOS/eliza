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
COLOR_BITS = 5
PAYLOAD_BITS = 32


def set_route(dut, tile: int, color: int, in_port: int, out_port: int) -> None:
    shadows = getattr(dut, "_route_table_shadow", [0, 0, 0, 0])
    shift = (color * PORTS + in_port) * 3
    mask = 0b111 << shift
    shadows[tile] = (shadows[tile] & ~mask) | ((out_port & 0b111) << shift)
    dut._route_table_shadow = shadows
    dut.route_table_flat[tile].value = shadows[tile]


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.repair_enable.value = 0
    dut._route_table_shadow = [0, 0, 0, 0]
    for tile in range(4):
        dut.port_disable[tile].value = 0
        dut.route_table_flat[tile].value = 0
        dut.inject_color[tile].value = 0
        dut.inject_payload[tile].value = 0
    dut.inject_valid.value = 0
    for _ in range(2):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def settle() -> None:
    await Timer(1, units="ns")


async def wait_mesh_hops(dut, cycles: int = 4) -> None:
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    await settle()


@cocotb.test()
async def two_hop_route_reaches_diagonal_tile(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    color = 6
    payload = 0xE1E1_0001
    set_route(dut, 0, color, DIR_LOCAL, DIR_EAST)
    set_route(dut, 1, color, DIR_WEST, DIR_SOUTH)
    set_route(dut, 3, color, DIR_NORTH, DIR_LOCAL)

    dut.inject_color[0].value = color
    dut.inject_payload[0].value = payload
    dut.inject_valid.value = 1
    await wait_mesh_hops(dut)

    assert int(dut.inject_ready.value) & 0x1
    assert int(dut.local_valid.value) & (1 << 3)
    assert int(dut.local_payload[3].value) == payload


@cocotb.test()
async def repaired_route_uses_south_then_east_when_direct_east_path_disabled(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    color = 9
    payload = 0xE1E1_0002
    dut.repair_enable.value = 1
    dut.port_disable[0].value = 1 << DIR_EAST

    set_route(dut, 0, color, DIR_LOCAL, DIR_SOUTH)
    set_route(dut, 2, color, DIR_NORTH, DIR_EAST)
    set_route(dut, 3, color, DIR_WEST, DIR_LOCAL)

    dut.inject_color[0].value = color
    dut.inject_payload[0].value = payload
    dut.inject_valid.value = 1
    await wait_mesh_hops(dut)

    assert int(dut.inject_ready.value) & 0x1
    assert int(dut.local_valid.value) & (1 << 3)
    assert int(dut.local_payload[3].value) == payload
    assert int(dut.repaired_drop[0].value) == 0


@cocotb.test()
async def unrepaired_disabled_direct_path_reports_drop(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    color = 10
    dut.repair_enable.value = 1
    dut.port_disable[0].value = 1 << DIR_EAST
    set_route(dut, 0, color, DIR_LOCAL, DIR_EAST)

    dut.inject_color[0].value = color
    dut.inject_payload[0].value = 0xE1E1_0003
    dut.inject_valid.value = 1
    await settle()

    assert int(dut.inject_ready.value) & 0x1
    assert int(dut.repaired_drop[0].value) & (1 << DIR_LOCAL)
    assert int(dut.local_valid.value) == 0
