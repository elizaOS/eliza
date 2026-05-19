"""BDI decompressor roundtrip test.

Pumps the compressor's output back through the decompressor and verifies
the original line is recovered for ZERO / REPEAT / B8D1 / B8D2 cases.

NOTE: this test instantiates the decompressor as TOPLEVEL because cocotb
runs one toplevel per Makefile invocation; the test harness drives the
form/base/deltas/raw inputs directly with values computed in Python.
"""

from __future__ import annotations

import cocotb
from cocotb.triggers import Timer


def _pack(words):
    line = 0
    for i, w in enumerate(words):
        line |= (w & ((1 << 64) - 1)) << (i * 64)
    return line


def _pack_deltas16(deltas):
    v = 0
    for i, d in enumerate(deltas):
        v |= (d & 0xFFFF) << (i * 16)
    return v


def _pack_deltas32(deltas):
    v = 0
    for i, d in enumerate(deltas):
        v |= (d & 0xFFFFFFFF) << (i * 32)
    return v


@cocotb.test()
async def test_decompress_zero(dut):
    dut.form_in.value = 0  # BDI_ZERO
    dut.base_in.value = 0
    dut.deltas_b8d1_in.value = 0
    dut.deltas_b8d2_in.value = 0
    dut.raw_in.value = 0
    await Timer(1, units="ns")
    assert int(dut.line_out.value) == 0


@cocotb.test()
async def test_decompress_repeat(dut):
    base = 0xC0FFEE_12345678
    dut.form_in.value = 1  # BDI_REPEAT
    dut.base_in.value = base
    dut.deltas_b8d1_in.value = 0
    dut.deltas_b8d2_in.value = 0
    dut.raw_in.value = 0
    await Timer(1, units="ns")
    expected = _pack([base] * 8)
    assert int(dut.line_out.value) == expected


@cocotb.test()
async def test_decompress_b8d1(dut):
    base = 0x1000
    deltas = [0, 1, 2, 3, -1, -2, 127, -128]
    expected = _pack([base + d for d in deltas])
    dut.form_in.value = 2  # BDI_B8D1
    dut.base_in.value = base
    dut.deltas_b8d1_in.value = _pack_deltas16(deltas)
    dut.deltas_b8d2_in.value = 0
    dut.raw_in.value = 0
    await Timer(1, units="ns")
    assert int(dut.line_out.value) == expected


@cocotb.test()
async def test_decompress_b8d2(dut):
    base = 0x10000
    deltas = [0, 100, -100, 32000, -32000, 1234, -5678, 9999]
    expected = _pack([base + d for d in deltas])
    dut.form_in.value = 3  # BDI_B8D2
    dut.base_in.value = base
    dut.deltas_b8d1_in.value = 0
    dut.deltas_b8d2_in.value = _pack_deltas32(deltas)
    dut.raw_in.value = 0
    await Timer(1, units="ns")
    assert int(dut.line_out.value) == expected


@cocotb.test()
async def test_decompress_none_raw(dut):
    raw = _pack(
        [
            0xDEADBEEFCAFEBABE,
            0xFEEDFACECAFEBABE,
            0x1234567890ABCDEF,
            0x0F0F0F0F0F0F0F0F,
            0xFFFFFFFFFFFFFFFF,
            0x0000000000000001,
            0x5555AAAA5555AAAA,
            0xDEC0DECAFEEDB00B,
        ]
    )
    dut.form_in.value = 7  # BDI_NONE
    dut.base_in.value = 0
    dut.deltas_b8d1_in.value = 0
    dut.deltas_b8d2_in.value = 0
    dut.raw_in.value = raw
    await Timer(1, units="ns")
    assert int(dut.line_out.value) == raw
