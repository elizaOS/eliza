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
COLOR_BITS = 5
PAYLOAD_BITS = 32


def route_word(logical_from: int, logical_to: int, direction: int, hops: int) -> int:
    return (logical_from << 40) | (logical_to << 19) | (direction << 16) | hops


def set_route(dut, color: int, in_port: int, out_port: int) -> None:
    flat = getattr(dut, "_route_table_shadow", 0)
    shift = (color * PORTS + in_port) * 3
    mask = 0b111 << shift
    flat = (flat & ~mask) | ((out_port & 0b111) << shift)
    dut._route_table_shadow = flat
    dut.route_table_flat.value = flat


def set_color(dut, port: int, color: int) -> None:
    flat = getattr(dut, "_fabric_color_shadow", 0)
    shift = port * COLOR_BITS
    mask = ((1 << COLOR_BITS) - 1) << shift
    flat = (flat & ~mask) | ((color & ((1 << COLOR_BITS) - 1)) << shift)
    dut._fabric_color_shadow = flat
    dut.fabric_color_flat.value = flat


def set_payload(dut, port: int, payload: int) -> None:
    flat = getattr(dut, "_fabric_payload_shadow", 0)
    shift = port * PAYLOAD_BITS
    mask = ((1 << PAYLOAD_BITS) - 1) << shift
    flat = (flat & ~mask) | ((payload & ((1 << PAYLOAD_BITS) - 1)) << shift)
    dut._fabric_payload_shadow = flat
    dut.fabric_payload_flat.value = flat


def set_src_dst(dut, port: int, src: int, dst: int) -> None:
    src_flat = getattr(dut, "_fabric_src_shadow", 0)
    dst_flat = getattr(dut, "_fabric_dst_shadow", 0)
    shift = port * 32
    mask = ((1 << 32) - 1) << shift
    src_flat = (src_flat & ~mask) | ((src & ((1 << 32) - 1)) << shift)
    dst_flat = (dst_flat & ~mask) | ((dst & ((1 << 32) - 1)) << shift)
    dut._fabric_src_shadow = src_flat
    dut._fabric_dst_shadow = dst_flat
    dut.fabric_src_logical_flat.value = src_flat
    dut.fabric_dst_logical_flat.value = dst_flat


def get_payload(dut, port: int) -> int:
    flat = int(dut.fabric_payload_out_flat.value)
    shift = port * PAYLOAD_BITS
    return (flat >> shift) & ((1 << PAYLOAD_BITS) - 1)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.core_enable.value = 0
    dut.core_instr_valid.value = 0
    dut.core_instr.value = 0
    dut.repair_enable.value = 0
    dut.repair_word_valid.value = 0
    dut.repair_word.value = 0
    dut.port_disable.value = 0
    dut.fabric_valid.value = 0
    dut.local_src_logical.value = 0
    dut.local_dst_logical.value = 0
    dut._route_table_shadow = 0
    dut._fabric_color_shadow = 0
    dut._fabric_payload_shadow = 0
    dut._fabric_src_shadow = 0
    dut._fabric_dst_shadow = 0
    dut.route_table_flat.value = 0
    dut.fabric_color_flat.value = 0
    dut.fabric_payload_flat.value = 0
    dut.fabric_src_logical_flat.value = 0
    dut.fabric_dst_logical_flat.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def send_word(dut, word: int) -> None:
    assert int(dut.repair_word_ready.value) == 1
    dut.repair_word.value = word
    dut.repair_word_valid.value = 1
    await RisingEdge(dut.clk)
    dut.repair_word_valid.value = 0
    await Timer(1, units="ns")


async def load_route_rom(dut) -> None:
    words = [
        MAGIC,
        (512 << 32) | 342,
        (528 << 32) | 358,
        0x3660,
        0,
        1,
        0x02CA_8D74_C57A_5C8A,
        0x34AB_E842_E3D3_2872,
        route_word(30, 40, DIR_WEST, 5),
    ]
    for word in words:
        await send_word(dut, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")


@cocotb.test()
async def repair_routed_tile_loads_rom_and_reroutes_fabric_wavelet(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await load_route_rom(dut)

    assert int(dut.repair_load_done.value) == 1
    assert int(dut.repair_load_error.value) == 0
    assert int(dut.repair_overflow.value) == 0
    assert int(dut.repair_route_count.value) == 1

    set_route(dut, color=9, in_port=DIR_EAST, out_port=DIR_SOUTH)
    set_color(dut, DIR_EAST, 9)
    set_payload(dut, DIR_EAST, 0xFEED_400D)
    set_src_dst(dut, DIR_EAST, 30, 40)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << DIR_SOUTH
    dut.fabric_valid.value = 1 << DIR_EAST
    await Timer(1, units="ns")

    assert int(dut.repair_override_used.value) & (1 << DIR_EAST)
    assert int(dut.fabric_ready.value) & (1 << DIR_EAST)
    assert int(dut.fabric_valid_out.value) & (1 << DIR_WEST)
    assert get_payload(dut, DIR_WEST) == 0xFEED_400D
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def repair_routed_tile_keeps_core_instruction_path_operational(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.core_enable.value = 1
    dut.core_instr.value = 0x0070_0093
    dut.core_instr_valid.value = 1
    await RisingEdge(dut.clk)
    dut.core_instr_valid.value = 0
    await Timer(1, units="ns")

    assert int(dut.core_x1.value) == 7
    assert int(dut.core_pc.value) == 4
    assert int(dut.core_active.value) == 1
