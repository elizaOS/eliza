from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

MAGIC = 0x4531_5852_4550_4149
PORTS = 5
DIR_NORTH = 0
DIR_EAST = 1
DIR_SOUTH = 2
DIR_WEST = 3
DIR_LOCAL = 4
DIR_DROP = 7


def route_word(logical_from: int, logical_to: int, direction: int, hops: int) -> int:
    return (logical_from << 40) | (logical_to << 19) | (direction << 16) | hops


def set_route(dut, tile: int, color: int, in_port: int, out_port: int) -> None:
    shadows = getattr(dut, "_route_table_shadow", [0, 0, 0, 0])
    shift = (color * PORTS + in_port) * 3
    mask = 0b111 << shift
    shadows[tile] = (shadows[tile] & ~mask) | ((out_port & 0b111) << shift)
    dut._route_table_shadow = shadows
    dut.route_table_flat[tile].value = shadows[tile]


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.repair_enable.value = 0
    dut._route_table_shadow = [0, 0, 0, 0]
    for tile in range(4):
        dut.repair_word_valid[tile].value = 0
        dut.repair_word[tile].value = 0
        dut.port_disable[tile].value = 0
        dut.route_table_flat[tile].value = 0
        dut.inject_color[tile].value = 0
        dut.inject_payload[tile].value = 0
        dut.inject_src_logical[tile].value = 0
        dut.inject_dst_logical[tile].value = 0
    dut.inject_valid.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def send_word(dut, tile: int, word: int) -> None:
    assert int(dut.repair_word_ready[tile].value) == 1
    dut.repair_word[tile].value = word
    dut.repair_word_valid[tile].value = 1
    await RisingEdge(dut.clk)
    dut.repair_word_valid[tile].value = 0
    await Timer(1, units="ns")


async def load_single_route_rom(dut, tile: int, direction: int, hops: int) -> None:
    words = [
        MAGIC,
        (2 << 32) | 2,
        (2 << 32) | 2,
        0,
        0,
        1,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        route_word(0, 3, direction, hops),
    ]
    for word in words:
        await send_word(dut, tile, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")


async def wait_mesh_hops(dut, cycles: int = 6) -> None:
    for _ in range(cycles):
        await RisingEdge(dut.clk)
    await Timer(1, units="ns")


@cocotb.test()
async def rom_loaded_repair_routes_deliver_across_2x2_mesh(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await load_single_route_rom(dut, tile=0, direction=DIR_SOUTH, hops=2)
    await load_single_route_rom(dut, tile=2, direction=DIR_EAST, hops=1)
    assert int(dut.repair_load_done[0].value) == 1
    assert int(dut.repair_load_done[2].value) == 1
    assert int(dut.repair_route_count[0].value) == 1
    assert int(dut.repair_route_count[2].value) == 1

    color = 11
    payload = 0xE1E1_2201
    dut.repair_enable.value = 1
    dut.port_disable[0].value = 1 << DIR_EAST

    set_route(dut, 0, color, DIR_LOCAL, DIR_EAST)
    set_route(dut, 2, color, DIR_NORTH, DIR_DROP)
    set_route(dut, 3, color, DIR_WEST, DIR_LOCAL)

    dut.inject_color[0].value = color
    dut.inject_payload[0].value = payload
    dut.inject_src_logical[0].value = 0
    dut.inject_dst_logical[0].value = 3
    dut.inject_valid.value = 1
    await wait_mesh_hops(dut)

    assert int(dut.inject_ready.value) & 0x1
    assert int(dut.repair_override_used[0].value) & (1 << DIR_LOCAL)
    assert int(dut.repair_override_used[2].value) & (1 << DIR_NORTH)
    assert int(dut.repaired_drop[0].value) == 0
    assert int(dut.repaired_drop[2].value) == 0
    assert int(dut.local_valid.value) & (1 << 3)
    assert int(dut.local_payload[3].value) == payload


@cocotb.test()
async def missing_second_hop_repair_record_drops_before_destination(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await load_single_route_rom(dut, tile=0, direction=DIR_SOUTH, hops=2)
    color = 12
    dut.repair_enable.value = 1
    dut.port_disable[0].value = 1 << DIR_EAST

    set_route(dut, 0, color, DIR_LOCAL, DIR_EAST)
    set_route(dut, 2, color, DIR_NORTH, DIR_DROP)
    set_route(dut, 3, color, DIR_WEST, DIR_LOCAL)

    dut.inject_color[0].value = color
    dut.inject_payload[0].value = 0xE1E1_2202
    dut.inject_src_logical[0].value = 0
    dut.inject_dst_logical[0].value = 3
    dut.inject_valid.value = 1
    await wait_mesh_hops(dut)

    assert int(dut.repair_override_used[0].value) & (1 << DIR_LOCAL)
    assert int(dut.local_valid.value) == 0
    assert int(dut.repaired_drop[2].value) & (1 << DIR_NORTH)
