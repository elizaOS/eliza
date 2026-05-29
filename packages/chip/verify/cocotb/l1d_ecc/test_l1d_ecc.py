"""Injection test for the L1D (72,64) Hsiao SEC-DED codec in e1_cache_pkg.

The codeword is {check[7:0], data[63:0]} (72 bits). Bit indices 0..63 are
data bits, 64..71 are check bits. The test:

  * round-trips clean words (no false errors),
  * flips every one of the 72 codeword bits and asserts the decode reports a
    single-bit error, does not report a double-bit error, and restores the
    original data (single-error correction),
  * flips many distinct double-bit pairs and asserts the decode reports a
    double-bit error, never a single-bit error, and never miscorrects to a
    different valid word,
  * checks the saturating corrected / uncorrectable status counters.

The Python golden model below independently constructs the same Hsiao H-matrix
(56 weight-3 columns + 8 weight-5 columns for data; weight-1 identity columns
for check) so the test pins the RTL to an externally-computed code rather than
trusting the RTL against itself.
"""

from __future__ import annotations

import random
from itertools import combinations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

DATA_BITS = 64
CHECK_BITS = 8
CODE_BITS = DATA_BITS + CHECK_BITS  # 72

DATA_PATTERNS = [
    0x0000_0000_0000_0000,
    0xFFFF_FFFF_FFFF_FFFF,
    0xA5A5_A5A5_A5A5_A5A5,
    0x5A5A_5A5A_5A5A_5A5A,
    0xDEAD_BEEF_CAFE_F00D,
    0x0123_4567_89AB_CDEF,
    0x8000_0000_0000_0001,
    0x0F0F_F0F0_3333_CCCC,
]


def _odd_columns(weight: int) -> list[int]:
    cols = []
    for combo in combinations(range(CHECK_BITS), weight):
        value = 0
        for bit in combo:
            value |= 1 << bit
        cols.append(value)
    return cols


# Data column vectors: 56 weight-3 + first 8 weight-5 = 64 distinct odd-weight
# 8-bit syndromes. Check columns are the 8 weight-1 identity vectors.
DATA_COLS = _odd_columns(3) + _odd_columns(5)[:8]
assert len(DATA_COLS) == DATA_BITS
CHECK_COLS = [1 << k for k in range(CHECK_BITS)]
ALL_COLS = DATA_COLS + CHECK_COLS  # index 0..71 maps to codeword bit position


def _popcount(value: int) -> int:
    return bin(value).count("1")


# Static proof that this is a valid SEC-DED Hsiao code, asserted at import.
assert len(set(ALL_COLS)) == CODE_BITS, "H-matrix columns are not distinct"
assert all(col != 0 and _popcount(col) % 2 == 1 for col in ALL_COLS), (
    "every H-matrix column must be a nonzero odd-weight vector"
)
_SINGLE_SYNDROMES = set(ALL_COLS)
for _a, _b in combinations(range(CODE_BITS), 2):
    _s = ALL_COLS[_a] ^ ALL_COLS[_b]
    assert _s != 0 and _popcount(_s) % 2 == 0, "double flip must be nonzero even"
    assert _s not in _SINGLE_SYNDROMES, "double flip aliases a single-bit syndrome"


def golden_encode(data: int) -> int:
    check = 0
    for bit in range(DATA_BITS):
        if (data >> bit) & 1:
            check ^= DATA_COLS[bit]
    return check


async def _settle(dut) -> None:
    await Timer(1, units="ns")


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.enc_data.value = 0
    dut.dec_valid.value = 0
    dut.dec_data.value = 0
    dut.dec_check.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def encode(dut, data: int) -> int:
    dut.enc_data.value = data
    await _settle(dut)
    return int(dut.enc_check.value)


async def decode(dut, data: int, check: int) -> tuple[int, int, int, int]:
    dut.dec_data.value = data
    dut.dec_check.value = check
    await _settle(dut)
    return (
        int(dut.dec_syndrome.value),
        int(dut.dec_single.value),
        int(dut.dec_double.value),
        int(dut.dec_corrected.value),
    )


@cocotb.test()
async def ecc_check_bits_match_golden_model(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(0xECC0)
    words = list(DATA_PATTERNS) + [rng.getrandbits(64) for _ in range(256)]
    for data in words:
        check = await encode(dut, data)
        assert check == golden_encode(data), (
            f"encode mismatch for {data:#018x}: rtl={check:#04x} "
            f"golden={golden_encode(data):#04x}"
        )


@cocotb.test()
async def ecc_round_trips_clean_words(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    for data in DATA_PATTERNS:
        check = await encode(dut, data)
        syn, single, double, corrected = await decode(dut, data, check)
        assert syn == 0, f"clean word {data:#018x} has nonzero syndrome {syn:#04x}"
        assert single == 0, f"clean word {data:#018x} flagged single error"
        assert double == 0, f"clean word {data:#018x} flagged double error"
        assert corrected == data, f"clean word corrupted: {corrected:#018x}"


@cocotb.test()
async def ecc_corrects_every_single_bit_flip(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    for data in DATA_PATTERNS:
        check = await encode(dut, data)
        for bit in range(CODE_BITS):
            if bit < DATA_BITS:
                corrupt_data = data ^ (1 << bit)
                corrupt_check = check
            else:
                corrupt_data = data
                corrupt_check = check ^ (1 << (bit - DATA_BITS))
            syn, single, double, corrected = await decode(
                dut, corrupt_data, corrupt_check
            )
            assert syn == ALL_COLS[bit], (
                f"single flip at codeword bit {bit} (data {data:#018x}) "
                f"syndrome {syn:#04x} != column {ALL_COLS[bit]:#04x}"
            )
            assert single == 1, (
                f"single flip at codeword bit {bit} (data {data:#018x}) "
                f"not flagged as SEC"
            )
            assert double == 0, (
                f"single flip at codeword bit {bit} (data {data:#018x}) "
                f"misflagged as DED"
            )
            assert corrected == data, (
                f"single flip at codeword bit {bit} (data {data:#018x}) "
                f"corrected to {corrected:#018x}, expected {data:#018x}"
            )


@cocotb.test()
async def ecc_detects_double_bit_flips_without_miscorrection(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(0xD00B)
    for data in DATA_PATTERNS:
        check = await encode(dut, data)
        pairs: set[tuple[int, int]] = set()
        while len(pairs) < 200:
            a = rng.randrange(CODE_BITS)
            b = rng.randrange(CODE_BITS)
            if a != b:
                pairs.add((min(a, b), max(a, b)))
        for a, b in pairs:
            corrupt_data = data
            corrupt_check = check
            for bit in (a, b):
                if bit < DATA_BITS:
                    corrupt_data ^= 1 << bit
                else:
                    corrupt_check ^= 1 << (bit - DATA_BITS)
            syn, single, double, corrected = await decode(
                dut, corrupt_data, corrupt_check
            )
            assert double == 1, (
                f"double flip at bits {a},{b} (data {data:#018x}) not detected"
            )
            assert single == 0, (
                f"double flip at bits {a},{b} (data {data:#018x}) misflagged as SEC"
            )
            # A correct DED must never silently produce a different valid word.
            assert corrected != data or (a >= DATA_BITS and b >= DATA_BITS), (
                f"double flip at bits {a},{b} (data {data:#018x}) "
                f"miscorrected back to a clean-looking word"
            )


@cocotb.test()
async def ecc_exhaustive_double_pairs_one_pattern(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    data = 0xA5A5_A5A5_5A5A_5A5A
    check = await encode(dut, data)
    for a, b in combinations(range(CODE_BITS), 2):
        corrupt_data = data
        corrupt_check = check
        for bit in (a, b):
            if bit < DATA_BITS:
                corrupt_data ^= 1 << bit
            else:
                corrupt_check ^= 1 << (bit - DATA_BITS)
        _syn, single, double, _corrected = await decode(
            dut, corrupt_data, corrupt_check
        )
        assert double == 1 and single == 0, (
            f"double flip at bits {a},{b} misclassified: single={single} double={double}"
        )


@cocotb.test()
async def ecc_status_counters_track_events(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    data = 0xDEAD_BEEF_CAFE_F00D
    check = await encode(dut, data)

    async def decode_clocked(d: int, c: int) -> None:
        dut.dec_valid.value = 1
        dut.dec_data.value = d
        dut.dec_check.value = c
        await RisingEdge(dut.clk)
        dut.dec_valid.value = 0
        await Timer(1, units="ns")

    await decode_clocked(data ^ 0x1, check)                  # single (data bit 0)
    await decode_clocked(data ^ 0x2, check)                  # single (data bit 1)
    await decode_clocked(data ^ 0x3, check)                  # double (bits 0 and 1)
    assert int(dut.corrected_count.value) == 2, int(dut.corrected_count.value)
    assert int(dut.uncorrectable_count.value) == 1, int(dut.uncorrectable_count.value)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")
    assert int(dut.corrected_count.value) == 0
    assert int(dut.uncorrectable_count.value) == 0
