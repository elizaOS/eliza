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

SRAM_BYTES = 48 * 1024
WAVELET_RX_DATA = SRAM_BYTES + 0x00
WAVELET_TX_DATA = SRAM_BYTES + 0x10

MASK64 = (1 << 64) - 1

OPIMM, OP, LOAD, STORE, LUI, SYSTEM = 0x13, 0x33, 0x03, 0x23, 0x37, 0x73


def i_type(imm: int, rs1: int, funct3: int, rd: int, opcode: int) -> int:
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode


def r_type(funct7: int, rs2: int, rs1: int, funct3: int, rd: int, opcode: int) -> int:
    return (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode


def s_type(imm: int, rs2: int, rs1: int, funct3: int, opcode: int) -> int:
    imm &= 0xFFF
    return (
        ((imm >> 5) << 25)
        | (rs2 << 20)
        | (rs1 << 15)
        | (funct3 << 12)
        | ((imm & 0x1F) << 7)
        | opcode
    )


def addi(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, OPIMM)


def add(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x0, rd, OP)


def mul(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x0, rd, OP)


def lui(rd: int, imm20: int) -> int:
    return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | LUI


def lw(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x2, rd, LOAD)


def sw(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x2, STORE)


ECALL = 0x0000_0073
NOP = addi(0, 0, 0)


def s64(value: int) -> int:
    value &= MASK64
    return value - (1 << 64) if value & (1 << 63) else value


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
    dut.core_boot_en.value = 0
    dut.core_boot_pc.value = 0
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


async def boot(dut, program: list[int], boot_pc: int = 0) -> None:
    """Stream a program into the PE local SRAM, then start fetch/execute."""
    dut.core_boot_en.value = 1
    dut.core_boot_pc.value = boot_pc
    for word in program:
        dut.core_instr.value = word & 0xFFFFFFFF
        dut.core_instr_valid.value = 1
        await RisingEdge(dut.clk)
    dut.core_instr_valid.value = 0
    await RisingEdge(dut.clk)
    dut.core_boot_en.value = 0
    dut.core_enable.value = 1
    await RisingEdge(dut.clk)


async def run_until_halt(dut, max_cycles: int = 4000) -> None:
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.core_halted.value) == 1:
            return
    raise AssertionError("PE core did not halt within cycle budget")


@cocotb.test()
async def pe_tile_boots_and_runs_rv64im_program(dut):
    """The real PE core (not the tiny core) boots a program that uses the M
    extension MUL — an instruction the 4-op tiny core cannot decode — and
    produces the correct RV64IM result inside the integrated tile."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    prog = [
        addi(1, 0, -7),  # x1 = -7
        addi(2, 0, 6),  # x2 = 6
        mul(3, 1, 2),  # x3 = -42  (M-extension; tiny core has no MUL)
        add(10, 3, 0),  # x10 = x3
        ECALL,
    ]
    await boot(dut, prog, boot_pc=0)
    await run_until_halt(dut)
    assert int(dut.core_halted.value) == 1
    assert int(dut.core_active.value) == 0
    assert s64(int(dut.core_x1.value)) == -7
    assert int(dut.core_x2.value) == 6
    assert s64(int(dut.core_x3.value)) == -42
    assert s64(int(dut.core_x10.value)) == -42


@cocotb.test()
async def pe_tile_exchanges_fabric_wavelet_through_real_core(dut):
    """A wavelet arrives on a neighbour port, the router steers it to Local, the
    real PE core reads it over MMIO, increments it, and stores it back to the
    wavelet TX MMIO; the router then forwards the egress wavelet to a neighbour
    output port. This proves the real core round-trips fabric traffic."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Program: read RX wavelet, add 1, write to TX wavelet, halt.
    prog = [
        lui(1, SRAM_BYTES >> 12),  # x1 = MMIO base (48KiB = 0xC000)
        lw(10, 1, 0x00),  # x10 = WAVELET_RX_DATA
        addi(11, 10, 1),  # x11 = x10 + 1
        sw(11, 1, 0x10),  # WAVELET_TX_DATA = x11
        ECALL,
    ]
    assert (SRAM_BYTES & 0xFFF) == 0
    assert WAVELET_RX_DATA == SRAM_BYTES
    assert WAVELET_TX_DATA == SRAM_BYTES + 0x10

    # Route: NORTH ingress (color 3) -> LOCAL (into core); LOCAL egress
    # (color 0) -> EAST (out to neighbour).
    set_route(dut, color=3, in_port=DIR_NORTH, out_port=DIR_LOCAL)
    set_route(dut, color=0, in_port=DIR_LOCAL, out_port=DIR_EAST)

    await boot(dut, prog, boot_pc=0)

    # Inject a wavelet from the NORTH neighbour.
    set_color(dut, DIR_NORTH, 3)
    set_payload(dut, DIR_NORTH, 0x0000_0041)
    dut.fabric_valid.value = 1 << DIR_NORTH
    await Timer(1, units="ns")
    assert int(dut.fabric_ready.value) & (1 << DIR_NORTH)
    await RisingEdge(dut.clk)
    dut.fabric_valid.value = 0

    saw_tx = False
    tx_payload = 0
    for _ in range(400):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.fabric_valid_out.value) & (1 << DIR_EAST):
            saw_tx = True
            tx_payload = get_payload(dut, DIR_EAST)
        if int(dut.core_halted.value) == 1:
            break

    assert int(dut.core_x10.value) == 0x41, "core did not read the RX wavelet over MMIO"
    assert saw_tx, "core never launched an egress wavelet onto the fabric"
    assert tx_payload == 0x42, "egress wavelet payload was not the incremented value"
    assert int(dut.repaired_drop.value) == 0
