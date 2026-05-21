"""Display timing / backpressure / underflow cocotb scaffolds.

DUT: ``rtl/display/e1_display.sv``.

Covers gaps tracked under
``verify/rtl_gap_work_order.yaml#areas.display.critical_gaps``:
- ``display-real-framebuffer-path``: hsync/vsync cadence and backpressure.
- ``display-proof-gap``: underflow counter under starved framebuffer reads.
"""

import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
from common import read_reg, write_reg  # noqa: E402

FB_BASE = 0x00
MODE = 0x04
FORMAT = 0x08
ENABLE = 0x0C
VSYNC = 0x10
UNDERFLOW_COUNT = 0x14
FETCHED_PIXEL_COUNT = 0x18

H_FRONT = 16
H_SYNC = 96
H_BACK = 48
V_FRONT = 10
V_SYNC = 2
V_BACK = 33


async def reset(dut):
    # Framebuffer-read sideband idles low through reset; the shared helper
    # drives the register port and the reset sequence.
    dut.fb_read_ready.value = 0
    dut.fb_read_data.value = 0
    await common.reset(dut)


async def perfect_fb(dut):
    while True:
        await RisingEdge(dut.clk)
        if int(dut.fb_read_valid.value):
            dut.fb_read_ready.value = 1
            dut.fb_read_data.value = 0x00112233
        else:
            dut.fb_read_ready.value = 0


async def starved_fb(dut, accept_every_n=8):
    n = 0
    while True:
        await RisingEdge(dut.clk)
        if int(dut.fb_read_valid.value):
            n += 1
            if n % accept_every_n == 0:
                dut.fb_read_ready.value = 1
                dut.fb_read_data.value = 0x00445566
            else:
                dut.fb_read_ready.value = 0
        else:
            dut.fb_read_ready.value = 0


@cocotb.test()
async def test_hsync_vsync_cadence(dut):
    """With a tiny 8x4 active area, hsync per line and vsync per frame must
    match the documented porches."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    cocotb.start_soon(perfect_fb(dut))
    width, height = 8, 4
    await write_reg(dut, FB_BASE, 0x8000_0000)
    await write_reg(dut, MODE, (height << 16) | width)
    await write_reg(dut, FORMAT, 0x34325258)  # 'XR24'
    await write_reg(dut, ENABLE, 1)

    line_total = width + H_FRONT + H_SYNC + H_BACK
    frame_lines = height + V_FRONT + V_SYNC + V_BACK
    total = line_total * frame_lines

    hsync_count = 0
    vsync_pulses = 0
    last_hs = 0
    last_vs = 0
    for _ in range(total * 2 + 50):
        await RisingEdge(dut.clk)
        hs = int(dut.scan_hsync.value)
        vs = int(dut.scan_vsync.value)
        if hs and not last_hs:
            hsync_count += 1
        if vs and not last_vs:
            vsync_pulses += 1
        last_hs = hs
        last_vs = vs
    assert vsync_pulses >= 2, f"vsync_pulses={vsync_pulses}"
    assert hsync_count >= frame_lines, f"hsync_count={hsync_count}"


@cocotb.test()
async def test_framebuffer_backpressure(dut):
    """A backpressuring framebuffer must not lose sync: fetched + underflow
    must equal active pixels presented so far."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    cocotb.start_soon(starved_fb(dut, accept_every_n=4))
    width, height = 8, 4
    await write_reg(dut, FB_BASE, 0x8000_0000)
    await write_reg(dut, MODE, (height << 16) | width)
    await write_reg(dut, FORMAT, 0x34325258)
    await write_reg(dut, ENABLE, 1)

    line_total = width + H_FRONT + H_SYNC + H_BACK
    frame_lines = height + V_FRONT + V_SYNC + V_BACK
    for _ in range(line_total * frame_lines + 100):
        await RisingEdge(dut.clk)
    fetched = await read_reg(dut, FETCHED_PIXEL_COUNT)
    under = await read_reg(dut, UNDERFLOW_COUNT)
    assert fetched + under == width * height, (
        f"fetched={fetched} under={under} active={width * height}"
    )


@cocotb.test()
async def test_underflow_counter_starved(dut):
    """A framebuffer that never returns ready must drive UNDERFLOW_COUNT
    to exactly active_pixels and FETCHED_PIXEL_COUNT to 0."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    async def never_ready():
        while True:
            await RisingEdge(dut.clk)
            dut.fb_read_ready.value = 0

    cocotb.start_soon(never_ready())
    width, height = 4, 2
    await write_reg(dut, FB_BASE, 0x8000_0000)
    await write_reg(dut, MODE, (height << 16) | width)
    await write_reg(dut, FORMAT, 0x34325258)
    await write_reg(dut, ENABLE, 1)
    line_total = width + H_FRONT + H_SYNC + H_BACK
    frame_lines = height + V_FRONT + V_SYNC + V_BACK
    for _ in range(line_total * frame_lines + 50):
        await RisingEdge(dut.clk)
    fetched = await read_reg(dut, FETCHED_PIXEL_COUNT)
    under = await read_reg(dut, UNDERFLOW_COUNT)
    assert fetched == 0, f"fetched={fetched}"
    assert under == width * height, f"under={under}, expected {width * height}"
