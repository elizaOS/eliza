from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


def addi(rd: int, rs1: int, imm: int) -> int:
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x13


def add(rd: int, rs1: int, rs2: int) -> int:
    return (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33


def sub(rd: int, rs1: int, rs2: int) -> int:
    return (0x20 << 25) | (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33


ECALL = 0x0000_0073
NOP = addi(0, 0, 0)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.enable.value = 0
    dut.instr_valid.value = 0
    dut.instr.value = NOP
    dut.wavelet_valid.value = 0
    dut.wavelet_payload.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def step_instr(dut, instr: int) -> None:
    dut.instr.value = instr
    dut.instr_valid.value = 1
    await RisingEdge(dut.clk)
    dut.instr_valid.value = 0
    await Timer(1, units="ns")


@cocotb.test()
async def tiny_core_executes_minimal_rv64i_integer_program(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.enable.value = 1
    await step_instr(dut, addi(1, 0, 5))
    await step_instr(dut, addi(2, 0, 7))
    await step_instr(dut, add(3, 1, 2))
    await step_instr(dut, sub(3, 3, 1))

    assert int(dut.x1.value) == 5
    assert int(dut.x2.value) == 7
    assert int(dut.x3.value) == 7
    assert int(dut.pc.value) == 0x1000_0010
    assert int(dut.active.value) == 1


@cocotb.test()
async def tiny_core_accumulates_wavelets_into_local_register(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.enable.value = 1
    dut.wavelet_payload.value = 0x10
    dut.wavelet_valid.value = 1
    await RisingEdge(dut.clk)
    dut.wavelet_payload.value = 0x08
    await RisingEdge(dut.clk)
    dut.wavelet_valid.value = 0
    await Timer(1, units="ns")

    assert int(dut.wavelet_ready.value) == 1
    assert int(dut.wavelet_out_valid.value) == 1
    assert int(dut.x10.value) == 0x18


@cocotb.test()
async def tiny_core_ecall_halts_fetch_and_wavelet_ingress(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.enable.value = 1
    await step_instr(dut, addi(1, 0, 1))
    await step_instr(dut, ECALL)
    pc_at_halt = int(dut.pc.value)
    await step_instr(dut, addi(1, 1, 1))
    dut.wavelet_valid.value = 1
    dut.wavelet_payload.value = 0xFF
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")

    assert int(dut.halted.value) == 1
    assert int(dut.active.value) == 0
    assert int(dut.wavelet_ready.value) == 0
    assert int(dut.x1.value) == 1
    assert int(dut.pc.value) == pc_at_halt
