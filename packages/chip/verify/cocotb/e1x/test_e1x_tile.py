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


def addi(rd: int, rs1: int, imm: int) -> int:
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x13


def add(rd: int, rs1: int, rs2: int) -> int:
    return (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33


ECALL = 0x0000_0073
NOP = addi(0, 0, 0)


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


def get_payload(dut, port: int) -> int:
    flat = int(dut.fabric_payload_out_flat.value)
    shift = port * PAYLOAD_BITS
    return (flat >> shift) & ((1 << PAYLOAD_BITS) - 1)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.core_enable.value = 0
    dut.core_instr_valid.value = 0
    dut.core_instr.value = NOP
    dut.repair_enable.value = 0
    dut.port_disable.value = 0
    dut._route_table_shadow = 0
    dut._fabric_color_shadow = 0
    dut._fabric_payload_shadow = 0
    dut.route_table_flat.value = 0
    dut.fabric_valid.value = 0
    dut.fabric_color_flat.value = 0
    dut.fabric_payload_flat.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def step_instr(dut, instr: int) -> None:
    dut.core_instr.value = instr
    dut.core_instr_valid.value = 1
    await RisingEdge(dut.clk)
    dut.core_instr_valid.value = 0
    await Timer(1, units="ns")


@cocotb.test()
async def tile_programs_core_through_instruction_port(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.core_enable.value = 1
    await step_instr(dut, addi(1, 0, 9))
    await step_instr(dut, addi(2, 0, 4))
    await step_instr(dut, add(3, 1, 2))

    assert int(dut.core_x1.value) == 9
    assert int(dut.core_x2.value) == 4
    assert int(dut.core_x3.value) == 13
    assert int(dut.core_pc.value) == 12
    assert int(dut.core_active.value) == 1


@cocotb.test()
async def tile_routes_fabric_wavelet_into_core_and_back_out(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.core_enable.value = 1
    set_route(dut, color=3, in_port=DIR_NORTH, out_port=DIR_LOCAL)
    set_route(dut, color=0, in_port=DIR_LOCAL, out_port=DIR_EAST)
    set_color(dut, DIR_NORTH, 3)
    set_payload(dut, DIR_NORTH, 0x0000_0042)
    dut.fabric_valid.value = 1 << DIR_NORTH
    await Timer(1, units="ns")

    assert int(dut.fabric_ready.value) & (1 << DIR_NORTH)
    await RisingEdge(dut.clk)
    dut.fabric_valid.value = 0
    await Timer(1, units="ns")

    assert int(dut.core_x10.value) == 0x42
    assert int(dut.fabric_valid_out.value) & (1 << DIR_EAST)
    assert get_payload(dut, DIR_EAST) == 0x42
    assert int(dut.repaired_drop.value) == 0


@cocotb.test()
async def tile_ecall_halts_integrated_core_and_blocks_wavelets(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.core_enable.value = 1
    await step_instr(dut, addi(1, 0, 1))
    await step_instr(dut, ECALL)
    pc_at_halt = int(dut.core_pc.value)

    set_route(dut, color=2, in_port=DIR_SOUTH, out_port=DIR_LOCAL)
    set_color(dut, DIR_SOUTH, 2)
    set_payload(dut, DIR_SOUTH, 0x55)
    dut.fabric_valid.value = 1 << DIR_SOUTH
    await RisingEdge(dut.clk)
    dut.fabric_valid.value = 0
    await Timer(1, units="ns")

    assert int(dut.core_halted.value) == 1
    assert int(dut.core_active.value) == 0
    assert int(dut.core_pc.value) == pc_at_halt
    assert int(dut.core_x1.value) == 1
    assert int(dut.core_x10.value) == 0
