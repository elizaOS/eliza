from __future__ import annotations

import json
import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

MASK64 = (1 << 64) - 1
REPO = Path(__file__).resolve().parents[3]
MICROKERNEL_PROOF_JSON = Path(
    os.environ.get(
        "E1X_W4A8_MICROKERNEL_PROOF_JSON",
        REPO / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
    )
)


def u64(value: int) -> int:
    return value & MASK64


def s64(value: int) -> int:
    value &= MASK64
    return value - (1 << 64) if value & (1 << 63) else value


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (int(word) >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


# ---- RV64 instruction encoders ----
def r_type(funct7: int, rs2: int, rs1: int, funct3: int, rd: int, opcode: int) -> int:
    return (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode


def i_type(imm: int, rs1: int, funct3: int, rd: int, opcode: int) -> int:
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode


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


def b_type(imm: int, rs2: int, rs1: int, funct3: int, opcode: int) -> int:
    imm &= 0x1FFF
    bit12 = (imm >> 12) & 1
    bit11 = (imm >> 11) & 1
    bits10_5 = (imm >> 5) & 0x3F
    bits4_1 = (imm >> 1) & 0xF
    return (
        (bit12 << 31)
        | (bits10_5 << 25)
        | (rs2 << 20)
        | (rs1 << 15)
        | (funct3 << 12)
        | (bits4_1 << 8)
        | (bit11 << 7)
        | opcode
    )


def u_type(imm: int, rd: int, opcode: int) -> int:
    return ((imm & 0xFFFFF) << 12) | (rd << 7) | opcode


def j_type(imm: int, rd: int, opcode: int) -> int:
    imm &= 0x1FFFFF
    bit20 = (imm >> 20) & 1
    bits10_1 = (imm >> 1) & 0x3FF
    bit11 = (imm >> 11) & 1
    bits19_12 = (imm >> 12) & 0xFF
    return (bit20 << 31) | (bits10_1 << 21) | (bit11 << 20) | (bits19_12 << 12) | (rd << 7) | opcode


# opcodes
OPIMM, OPIMM32, OP, OP32 = 0x13, 0x1B, 0x33, 0x3B
LOAD, STORE = 0x03, 0x23
BRANCH, JAL, JALR = 0x63, 0x6F, 0x67
LUI, AUIPC, SYSTEM, FENCE = 0x37, 0x17, 0x73, 0x0F


def addi(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, OPIMM)


def slti(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x2, rd, OPIMM)


def sltiu(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x3, rd, OPIMM)


def xori(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x4, rd, OPIMM)


def ori(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x6, rd, OPIMM)


def andi(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x7, rd, OPIMM)


def slli(rd: int, rs1: int, sh: int) -> int:
    return i_type(sh & 0x3F, rs1, 0x1, rd, OPIMM)


def srli(rd: int, rs1: int, sh: int) -> int:
    return i_type(sh & 0x3F, rs1, 0x5, rd, OPIMM)


def srai(rd: int, rs1: int, sh: int) -> int:
    return i_type((0x10 << 6) | (sh & 0x3F), rs1, 0x5, rd, OPIMM)


def addiw(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, OPIMM32)


def slliw(rd: int, rs1: int, sh: int) -> int:
    return i_type(sh & 0x1F, rs1, 0x1, rd, OPIMM32)


def srliw(rd: int, rs1: int, sh: int) -> int:
    return i_type(sh & 0x1F, rs1, 0x5, rd, OPIMM32)


def sraiw(rd: int, rs1: int, sh: int) -> int:
    return i_type((0x20 << 5) | (sh & 0x1F), rs1, 0x5, rd, OPIMM32)


def add(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x0, rd, OP)


def sub(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x20, rs2, rs1, 0x0, rd, OP)


def sll(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x1, rd, OP)


def slt(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x2, rd, OP)


def sltu(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x3, rd, OP)


def xor_(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x4, rd, OP)


def srl(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x5, rd, OP)


def sra(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x20, rs2, rs1, 0x5, rd, OP)


def or_(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x6, rd, OP)


def and_(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x7, rd, OP)


def addw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x0, rd, OP32)


def subw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x20, rs2, rs1, 0x0, rd, OP32)


def sllw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x1, rd, OP32)


def srlw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0, rs2, rs1, 0x5, rd, OP32)


def sraw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(0x20, rs2, rs1, 0x5, rd, OP32)


def mul(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x0, rd, OP)


def mulh(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x1, rd, OP)


def mulhsu(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x2, rd, OP)


def mulhu(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x3, rd, OP)


def div(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x4, rd, OP)


def divu(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x5, rd, OP)


def rem(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x6, rd, OP)


def remu(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x7, rd, OP)


def mulw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x0, rd, OP32)


def divw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x4, rd, OP32)


def divuw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x5, rd, OP32)


def remw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x6, rd, OP32)


def remuw(rd: int, rs1: int, rs2: int) -> int:
    return r_type(1, rs2, rs1, 0x7, rd, OP32)


def lb(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, LOAD)


def lh(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x1, rd, LOAD)


def lw(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x2, rd, LOAD)


def ld(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x3, rd, LOAD)


def lbu(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x4, rd, LOAD)


def lhu(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x5, rd, LOAD)


def lwu(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x6, rd, LOAD)


def sb(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x0, STORE)


def sh(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x1, STORE)


def sw(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x2, STORE)


def sd(rs2: int, rs1: int, imm: int) -> int:
    return s_type(imm, rs2, rs1, 0x3, STORE)


def beq(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x0, BRANCH)


def bne(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x1, BRANCH)


def blt(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x4, BRANCH)


def bge(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x5, BRANCH)


def bltu(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x6, BRANCH)


def bgeu(rs1: int, rs2: int, imm: int) -> int:
    return b_type(imm, rs2, rs1, 0x7, BRANCH)


def jal(rd: int, imm: int) -> int:
    return j_type(imm, rd, JAL)


def jalr(rd: int, rs1: int, imm: int) -> int:
    return i_type(imm, rs1, 0x0, rd, JALR)


def lui(rd: int, imm20: int) -> int:
    return u_type(imm20, rd, LUI)


def auipc(rd: int, imm20: int) -> int:
    return u_type(imm20, rd, AUIPC)


def csrrw(rd: int, csr: int, rs1: int) -> int:
    return i_type(csr, rs1, 0x1, rd, SYSTEM)


def csrrs(rd: int, csr: int, rs1: int) -> int:
    return i_type(csr, rs1, 0x2, rd, SYSTEM)


def csrrc(rd: int, csr: int, rs1: int) -> int:
    return i_type(csr, rs1, 0x3, rd, SYSTEM)


def csrrwi(rd: int, csr: int, uimm: int) -> int:
    return i_type(csr, uimm, 0x5, rd, SYSTEM)


def fence() -> int:
    return i_type(0, 0, 0x0, 0, FENCE)


def fence_i() -> int:
    return i_type(0, 0, 0x1, 0, FENCE)


ECALL = 0x00000073
EBREAK = 0x00100073
NOP = addi(0, 0, 0)

CSR_MCYCLE = 0xB00
CSR_MINSTRET = 0xB02
CSR_MSCRATCH = 0x340
CSR_MHARTID = 0xF14


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.enable.value = 0
    dut.boot_en.value = 0
    dut.boot_pc.value = 0
    dut.instr_valid.value = 0
    dut.instr.value = 0
    dut.wavelet_valid.value = 0
    dut.wavelet_payload.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def boot(dut, program: list[int], boot_pc: int = 0) -> None:
    """Load a program into local SRAM over the boot stream, then start."""
    dut.boot_en.value = 1
    dut.boot_pc.value = boot_pc
    for word in program:
        dut.instr.value = word & 0xFFFFFFFF
        dut.instr_valid.value = 1
        await RisingEdge(dut.clk)
    dut.instr_valid.value = 0
    await RisingEdge(dut.clk)
    dut.boot_en.value = 0
    dut.enable.value = 1
    await RisingEdge(dut.clk)


async def run_until_halt(dut, max_cycles: int = 4000) -> None:
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.halted.value) == 1:
            return
    raise AssertionError("core did not halt within cycle budget")


async def run_program(dut, program: list[int], boot_pc: int = 0) -> None:
    await reset(dut)
    await boot(dut, program, boot_pc)
    await run_until_halt(dut)


def reg(dut, name: str) -> int:
    return int(getattr(dut, name).value)


def load_w4a8_proof_record() -> dict:
    proof = json.loads(MICROKERNEL_PROOF_JSON.read_text(encoding="utf-8"))
    assert proof["schema"] == "eliza.e1x.w4a8_microkernel_proof.v1"
    record = proof["records"][0]
    row = record["row_results"][0]
    activations = [int(value) for value in record["activation_s8"]]
    weights = [
        weight
        for word_hex in row["packed_w4_words_hex"]
        for weight in unpack_signed_w4_word(int(word_hex, 16))
    ][: len(activations)]
    accumulator = sum(a * w for a, w in zip(activations, weights, strict=True))
    assert accumulator == int(row["accumulator"])
    requantized = max(-128, min(127, accumulator >> 7))
    assert requantized == int(row["requantized_s8"])
    return {
        "layer_name": record["layer_name"],
        "activations": activations,
        "weights": weights,
        "accumulator": accumulator,
        "requantized": requantized,
    }


@cocotb.test()
async def integer_arithmetic_and_immediates(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 5),
        addi(2, 0, 7),
        add(3, 1, 2),  # 12
        sub(5, 2, 1),  # 2
        addi(6, 0, -1),  # -1 sign extended
        xori(7, 1, 0x0F),  # 5 ^ 15 = 10
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x1") == 5
    assert reg(dut, "x2") == 7
    assert reg(dut, "x3") == 12
    assert reg(dut, "x5") == 2
    assert s64(reg(dut, "x6")) == -1
    assert reg(dut, "x7") == 10


@cocotb.test()
async def shifts_and_set_less_than(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 1),
        slli(2, 1, 40),  # 1 << 40
        addi(3, 0, -16),  # 0xFFFF...F0
        srai(5, 3, 2),  # arithmetic >> 2 = -4
        srli(6, 1, 0),  # 1
        slti(7, 3, 0),  # -16 < 0 -> 1
        sltiu(28, 1, 5),  # 1 <u 5 -> 1
        addi(11, 0, 40),  # shift amount 40
        sll(29, 1, 11),  # 1 << (x11[5:0]=40) -> 1<<40
        srl(30, 2, 11),  # (1<<40) >> 40 -> 1
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x2") == (1 << 40)
    assert s64(reg(dut, "x5")) == -4
    assert reg(dut, "x6") == 1
    assert reg(dut, "x7") == 1
    assert reg(dut, "x28") == 1
    assert reg(dut, "x29") == (1 << 40)
    assert reg(dut, "x30") == 1


@cocotb.test()
async def word_operations_sign_extend(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        lui(1, 0x80000),  # x1 = 0xFFFF_FFFF_8000_0000 (sext of 0x80000<<12)
        addiw(2, 0, 1),  # 1
        addw(3, 1, 2),  # (0x80000000 + 1) as 32 -> 0x80000001 sext = negative
        slliw(5, 2, 31),  # 1<<31 -> 0x80000000 sext negative
        sraiw(6, 5, 31),  # -1
        subw(7, 0, 2),  # -1
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x3") == u64(-0x7FFFFFFF)  # 0x80000001 sign extended
    assert s64(reg(dut, "x5")) == -(1 << 31)
    assert s64(reg(dut, "x6")) == -1
    assert s64(reg(dut, "x7")) == -1


@cocotb.test()
async def branches_taken_and_not_taken(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    # counts loop iterations: x1 from 0..5
    prog = [
        addi(1, 0, 0),  # i = 0
        addi(2, 0, 5),  # n = 5
        addi(3, 0, 0),  # sum = 0
        # loop:  (addr 12)
        add(3, 3, 1),  # sum += i
        addi(1, 1, 1),  # i += 1
        blt(1, 2, -8),  # if i < n goto loop
        beq(0, 0, 8),  # taken: skip next
        addi(3, 0, 999),  # should be skipped
        addi(5, 0, 42),  # marker
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x1") == 5
    assert reg(dut, "x3") == 0 + 1 + 2 + 3 + 4  # sum 0..4
    assert reg(dut, "x5") == 42


@cocotb.test()
async def jal_jalr_control_flow(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    # main calls a "function" that sets x10=123 and returns via jalr ra
    prog = [
        addi(2, 0, 0),  # 0: clobber-check reg
        jal(1, 12),  # 4: call func at 4+12=16, ra=8
        addi(2, 0, 7),  # 8: after return
        ECALL,  # 12: halt
        addi(10, 0, 123),  # 16: func: x10 = 123
        jalr(0, 1, 0),  # 20: ret -> ra (8)
    ]
    await run_program(dut, prog)
    assert reg(dut, "x10") == 123
    assert reg(dut, "x2") == 7
    assert reg(dut, "x1") == 8  # return address captured


@cocotb.test()
async def loads_stores_roundtrip(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    base = 0x2000
    prog = [
        lui(1, base >> 12),  # x1 = base (base is 0x2000, fits in upper imm)
        addi(2, 0, 0x55),
        sd(2, 1, 0),  # store doubleword
        addi(3, 0, -1),
        sw(3, 1, 8),  # store 0xFFFFFFFF word
        addi(5, 0, 0x7B),
        sh(5, 1, 12),  # store halfword 0x007B
        addi(6, 0, -2),
        sb(6, 1, 16),  # store byte 0xFE
        ld(7, 1, 0),  # load back doubleword -> 0x55
        lw(28, 1, 8),  # load word sign ext -> -1
        lwu(29, 1, 8),  # load word zero ext -> 0xFFFFFFFF
        lhu(30, 1, 12),  # 0x7B
        lb(31, 1, 16),  # -2
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x7") == 0x55
    assert s64(reg(dut, "x28")) == -1
    assert reg(dut, "x29") == 0xFFFFFFFF
    assert reg(dut, "x30") == 0x7B
    assert s64(reg(dut, "x31")) == -2


@cocotb.test()
async def mul_div_rem_correctness(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, -7),  # -7
        addi(2, 0, 3),  # 3
        mul(3, 1, 2),  # -21
        div(5, 1, 2),  # -7/3 = -2 (trunc toward zero)
        rem(6, 1, 2),  # -7 % 3 = -1
        divu(7, 1, 2),  # huge unsigned / 3
        remu(28, 1, 2),
        mulh(29, 1, 2),  # high bits of -7*3 = -1
        mulhu(30, 2, 2),  # high of 3*3 = 0
        ECALL,
    ]
    await run_program(dut, prog)
    assert s64(reg(dut, "x3")) == -21
    assert s64(reg(dut, "x5")) == -2
    assert s64(reg(dut, "x6")) == -1
    a = u64(-7)
    assert reg(dut, "x7") == a // 3
    assert reg(dut, "x28") == a % 3
    assert s64(reg(dut, "x29")) == -1
    assert reg(dut, "x30") == 0


@cocotb.test()
async def div_by_zero_and_overflow(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 5),
        addi(2, 0, 0),
        div(3, 1, 2),  # 5/0 -> -1 (all ones)
        rem(5, 1, 2),  # 5%0 -> 5
        divu(6, 1, 2),  # 5/0 -> all ones
        remu(7, 1, 2),  # 5%0 -> 5
        # overflow: INT_MIN / -1
        addi(28, 0, -1),
        slli(29, 28, 63),  # 0x8000...0000 = INT64_MIN
        div(30, 29, 28),  # INT_MIN / -1 -> INT_MIN
        rem(31, 29, 28),  # INT_MIN % -1 -> 0
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x3") == MASK64
    assert reg(dut, "x5") == 5
    assert reg(dut, "x6") == MASK64
    assert reg(dut, "x7") == 5
    assert reg(dut, "x30") == (1 << 63)
    assert reg(dut, "x31") == 0


@cocotb.test()
async def word_mul_div(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, -7),
        addi(2, 0, 3),
        mulw(3, 1, 2),  # (-7*3) as 32 sext = -21
        divw(5, 1, 2),  # -2
        remw(6, 1, 2),  # -1
        addi(7, 0, 17),
        addi(28, 0, 5),
        divuw(29, 7, 28),  # 17/5 = 3
        remuw(30, 7, 28),  # 17%5 = 2
        ECALL,
    ]
    await run_program(dut, prog)
    assert s64(reg(dut, "x3")) == -21
    assert s64(reg(dut, "x5")) == -2
    assert s64(reg(dut, "x6")) == -1
    assert reg(dut, "x29") == 3
    assert reg(dut, "x30") == 2


@cocotb.test()
async def lui_auipc(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        lui(1, 0x12345),  # x1 = 0x12345000
        auipc(2, 0),  # x2 = pc(=4) + 0 = 4
        addi(3, 1, 0x678),  # 0x12345678
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x1") == 0x12345000
    assert reg(dut, "x2") == 4
    assert reg(dut, "x3") == 0x12345678


@cocotb.test()
async def csr_mcycle_minstret_mscratch(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        csrrs(1, CSR_MINSTRET, 0),  # read minstret early
        addi(0, 0, 0),
        addi(0, 0, 0),
        addi(0, 0, 0),
        csrrs(2, CSR_MINSTRET, 0),  # later, larger
        csrrs(5, CSR_MCYCLE, 0),  # mcycle snapshot 1
        addi(0, 0, 0),
        csrrs(6, CSR_MCYCLE, 0),  # mcycle snapshot 2 (larger)
        addi(7, 0, 0x2A),
        csrrw(0, CSR_MSCRATCH, 7),  # write mscratch = 42
        csrrs(28, CSR_MSCRATCH, 0),  # read back 42
        csrrs(29, CSR_MHARTID, 0),  # 0
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x2") > reg(dut, "x1")
    assert reg(dut, "x6") > reg(dut, "x5")
    assert reg(dut, "x28") == 42
    assert reg(dut, "x29") == 0


@cocotb.test()
async def fence_is_ordering_nop(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 9),
        fence(),
        fence_i(),
        addi(2, 1, 1),
        ECALL,
    ]
    await run_program(dut, prog)
    assert reg(dut, "x1") == 9
    assert reg(dut, "x2") == 10


@cocotb.test()
async def ecall_halts(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 3),
        ECALL,
        addi(1, 1, 100),  # must never execute
    ]
    await run_program(dut, prog)
    assert int(dut.halted.value) == 1
    assert int(dut.active.value) == 0
    assert reg(dut, "x1") == 3


@cocotb.test()
async def ebreak_halts(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    prog = [
        addi(1, 0, 4),
        EBREAK,
        addi(1, 1, 100),
    ]
    await run_program(dut, prog)
    assert int(dut.halted.value) == 1
    assert reg(dut, "x1") == 4


@cocotb.test()
async def wavelet_mmio_rx_tx(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    sram_bytes = 48 * 1024
    rx_data = sram_bytes + 0x00
    tx_data = sram_bytes + 0x10
    # program: load rx into x10, add 1, store to tx
    prog = [
        lui(1, (sram_bytes >> 12)),  # x1 = sram_bytes base of MMIO (48KiB = 0xC000)
        lw(10, 1, 0x00),  # read WAVELET_RX_DATA
        addi(11, 10, 1),
        sw(11, 1, 0x10),  # write WAVELET_TX_DATA
        ECALL,
    ]
    assert (sram_bytes & 0xFFF) == 0
    assert rx_data == sram_bytes
    assert tx_data == sram_bytes + 0x10
    await reset(dut)
    await boot(dut, prog, boot_pc=0)
    # deliver a wavelet
    dut.wavelet_payload.value = 0x41
    dut.wavelet_valid.value = 1
    await RisingEdge(dut.clk)
    dut.wavelet_valid.value = 0
    # run and watch for tx
    saw_tx = False
    tx_payload = 0
    for _ in range(200):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.wavelet_out_valid.value) == 1:
            saw_tx = True
            tx_payload = int(dut.wavelet_out_payload.value)
        if int(dut.halted.value) == 1:
            break
    assert reg(dut, "x10") == 0x41
    assert saw_tx
    assert tx_payload == 0x42


@cocotb.test()
async def generated_w4a8_microkernel_dot_runs_on_pe_core(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    proof = load_w4a8_proof_record()
    prog = [addi(10, 0, 0)]
    for activation, weight in zip(proof["activations"], proof["weights"], strict=True):
        prog.extend(
            [
                addi(11, 0, activation),
                addi(12, 0, weight),
                mul(11, 11, 12),
                add(10, 10, 11),
            ]
        )
    prog.extend(
        [
            srai(11, 10, 7),
            ECALL,
        ]
    )
    await run_program(dut, prog, boot_pc=0)
    assert s64(reg(dut, "x10")) == int(proof["accumulator"])
    assert s64(reg(dut, "x11")) == int(proof["requantized"])
