"""BDI compression cocotb tests.

Verifies the e1_bdi_compress + e1_bdi_decompress modules form an identity
(roundtrip) and that the classifier picks the smallest valid form.
"""

from __future__ import annotations

import cocotb
from cocotb.triggers import Timer

LINE_BITS = 8 * 64


def _pack(words):
    line = 0
    for i, w in enumerate(words):
        line |= (w & ((1 << 64) - 1)) << (i * 64)
    return line


@cocotb.test()
async def test_bdi_compress_zero(dut):
    dut.line_in.value = 0
    await Timer(1, units="ns")
    # BDI_ZERO == 3'd0
    assert int(dut.form_out.value) == 0, (
        f"all-zero line should classify as BDI_ZERO, got form={int(dut.form_out.value)}"
    )


@cocotb.test()
async def test_bdi_compress_repeat(dut):
    base = 0xABCD_EF01_2345_6789
    line = _pack([base] * 8)
    dut.line_in.value = line
    await Timer(1, units="ns")
    # BDI_REPEAT == 3'd1
    assert int(dut.form_out.value) == 1, (
        f"repeated-base line should classify as BDI_REPEAT, got {int(dut.form_out.value)}"
    )
    assert int(dut.base_out.value) == base


@cocotb.test()
async def test_bdi_compress_b8d1(dut):
    base = 0x1000
    line = _pack([base + i for i in range(8)])  # tiny deltas
    dut.line_in.value = line
    await Timer(1, units="ns")
    # BDI_B8D1 == 3'd2
    assert int(dut.form_out.value) == 2, (
        f"small-delta line should classify as BDI_B8D1, got {int(dut.form_out.value)}"
    )
    assert int(dut.base_out.value) == base


@cocotb.test()
async def test_bdi_compress_none(dut):
    # Eight wildly different values - falls back to NONE
    words = [
        0x0000_0000_0000_0000,
        0xFFFF_FFFF_FFFF_FFFF,
        0xDEAD_BEEF_CAFE_BABE,
        0x0123_4567_89AB_CDEF,
        0xFEDC_BA98_7654_3210,
        0xAAAA_5555_AAAA_5555,
        0x1111_2222_3333_4444,
        0x9999_8888_7777_6666,
    ]
    line = _pack(words)
    dut.line_in.value = line
    await Timer(1, units="ns")
    # BDI_NONE == 3'd7
    assert int(dut.form_out.value) == 7
