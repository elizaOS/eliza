from __future__ import annotations

import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

CODE_BITS = 39
DATA_BITS = 32

DATA_PATTERNS = [
    0x0000_0000,
    0xFFFF_FFFF,
    0xA5A5_A5A5,
    0x5A5A_5A5A,
    0xDEAD_BEEF,
    0x0123_4567,
    0x8000_0001,
    0xCAFE_F00D,
]


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.enc_valid.value = 0
    dut.enc_data.value = 0
    dut.dec_valid.value = 0
    dut.dec_code.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def encode(dut, data: int) -> int:
    dut.enc_valid.value = 1
    dut.enc_data.value = data
    await Timer(1, units="ns")
    code = int(dut.enc_code.value)
    dut.enc_valid.value = 0
    return code


async def decode(dut, code: int) -> tuple[int, int, int]:
    dut.dec_valid.value = 1
    dut.dec_code.value = code
    await Timer(1, units="ns")
    data = int(dut.dec_data.value)
    single = int(dut.dec_single_error.value)
    double = int(dut.dec_double_error.value)
    dut.dec_valid.value = 0
    return data, single, double


@cocotb.test()
async def ecc_round_trips_clean_words(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    for data in DATA_PATTERNS:
        code = await encode(dut, data)
        out, single, double = await decode(dut, code)
        assert out == data, f"clean decode mismatch: {out:#010x} != {data:#010x}"
        assert single == 0, f"clean word flagged single error for {data:#010x}"
        assert double == 0, f"clean word flagged double error for {data:#010x}"


@cocotb.test()
async def ecc_corrects_every_single_bit_flip(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    for data in DATA_PATTERNS:
        code = await encode(dut, data)
        for bit in range(CODE_BITS):
            corrupted = code ^ (1 << bit)
            out, single, double = await decode(dut, corrupted)
            assert single == 1, (
                f"single-bit flip at bit {bit} (data {data:#010x}) not flagged as SEC"
            )
            assert double == 0, (
                f"single-bit flip at bit {bit} (data {data:#010x}) misflagged as DED"
            )
            assert out == data, (
                f"single-bit flip at bit {bit} (data {data:#010x}) "
                f"corrected to {out:#010x}, expected {data:#010x}"
            )


@cocotb.test()
async def ecc_detects_double_bit_flips_without_miscorrection(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(0xD1F7)
    for data in DATA_PATTERNS:
        code = await encode(dut, data)
        # Exhaustively cover a sample of distinct double-bit flips per pattern.
        pairs: set[tuple[int, int]] = set()
        while len(pairs) < 64:
            a = rng.randrange(CODE_BITS)
            b = rng.randrange(CODE_BITS)
            if a != b:
                pairs.add((min(a, b), max(a, b)))
        for a, b in pairs:
            corrupted = code ^ (1 << a) ^ (1 << b)
            _out, single, double = await decode(dut, corrupted)
            assert double == 1, (
                f"double-bit flip at bits {a},{b} (data {data:#010x}) not detected as DED"
            )
            assert single == 0, (
                f"double-bit flip at bits {a},{b} (data {data:#010x}) misflagged as SEC"
            )


@cocotb.test()
async def ecc_status_counters_track_events(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    data = 0xA5A5_A5A5
    code = await encode(dut, data)

    # Drive registered decode events on clock edges to advance counters.
    async def decode_clocked(c: int) -> None:
        dut.dec_valid.value = 1
        dut.dec_code.value = c
        await RisingEdge(dut.clk)
        dut.dec_valid.value = 0
        await Timer(1, units="ns")

    await decode_clocked(code ^ 0x1)  # single
    await decode_clocked(code ^ 0x2)  # single
    await decode_clocked(code ^ 0x3)  # double (bits 0 and 1)
    assert int(dut.corrected_count.value) == 2, int(dut.corrected_count.value)
    assert int(dut.detected_double_count.value) == 1, int(dut.detected_double_count.value)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")
    assert int(dut.corrected_count.value) == 0
    assert int(dut.detected_double_count.value) == 0
