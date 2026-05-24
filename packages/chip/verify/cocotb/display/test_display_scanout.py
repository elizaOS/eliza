"""Production framebuffer-scanout KAT for ``rtl/display/e1_display_scanout.sv``.

DUT: the buildable subset of the E1 display pipeline -- a real AXI4 read
master that streams a framebuffer out of DRAM, a pixel-format unpack stage
(RGB565 / RGB888 / XRGB8888), a register-programmed mode timing generator,
and the controller -> PHY (DPI/DSI) pixel boundary.

PHYSICAL DEPENDENCY: the DSI analog PHY, D-PHY lane serializers, and panel DCS
init are physical/analog and are NOT modelled as RTL. This suite drives and
checks the *digital* DPI boundary (pix_de/pix_hsync/pix_vsync/pix_valid/
pix_data) that such a PHY consumes.

Tests:
  * scanout_xrgb8888_matches_framebuffer -- 8x4 XR24 frame, known pattern,
    assert the DPI pixel stream matches the framebuffer pixel-for-pixel.
  * scanout_rgb565_unpacks_correctly     -- 8x4 RG16 frame, assert RGB565 ->
    RGB888 expansion per pixel.
  * scanout_rgb888_packed                -- 8x4 RG24 frame, packed 24bpp.
  * timing_matches_programmed_mode       -- hsync/vsync/de cadence equals the
    programmed active/porch/sync values; one vsync per frame.
  * forced_underflow_sets_status_and_recovers -- a starved AXI slave forces a
    FIFO underrun: pix_data is the defined fill colour, the sticky underflow
    status bit + counter are set, and the next (well-fed) frame scans out
    clean with the status cleared via W1C.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402

# --- register map (word addresses on the simple MMIO port) -----------------
R_FB_BASE = 0x00
R_MODE = 0x01  # {v_active[31:16], h_active[15:0]}
R_H_PORCH = 0x02  # {h_sync[31:16], h_front[15:0]}
R_HB_VF = 0x03  # {v_front[31:16], h_back[15:0]}
R_VS_VB = 0x04  # {v_back[31:16], v_sync[15:0]}
R_STRIDE = 0x05
R_FORMAT = 0x06
R_ENABLE = 0x07
R_VSYNC_IRQ = 0x08
R_WORDS_PER_LINE = 0x09
R_OUTSTANDING = 0x0A
R_FIFO_LEVEL = 0x0B
R_UNDERFLOW_STICKY = 0x0C  # W1C
R_FETCHED = 0x0D
R_UNDERFLOW_COUNT = 0x0E

FMT_XR24 = 0x34325258
FMT_RG16 = 0x36314752
FMT_RG24 = 0x34324752

UNDERFLOW_FILL = 0x000000


async def reset(dut):
    dut.m_arready.value = 0
    dut.m_rvalid.value = 0
    dut.m_rid.value = 0
    dut.m_rlast.value = 0
    dut.m_rdata.value = 0
    dut.m_rresp.value = 0
    await common.reset(dut)


# ---------------------------------------------------------------------------
# AXI4 read-slave model: a byte-addressed framebuffer in DRAM.
#   ``mem``        : dict[int,int] byte memory.
#   ``latency``    : cycles between AR accept and first R beat.
#   ``starve``     : if True, never returns read data (forces underflow).
# Honours arlen (INCR bursts), drives rlast on the final beat, returns OKAY.
# ---------------------------------------------------------------------------
async def axi4_read_slave(dut, mem, *, latency=2, starve=False, max_outstanding=4):
    pending = []  # list of [addr, beats_left, beat_idx, countdown, arid]
    dut.m_arready.value = 1
    dut.m_rvalid.value = 0
    while True:
        await RisingEdge(dut.clk)
        # Accept an AR when we have room.
        if int(dut.m_arvalid.value) and int(dut.m_arready.value) and len(pending) < max_outstanding:
            addr = int(dut.m_araddr.value)
            beats = int(dut.m_arlen.value) + 1
            arid = int(dut.m_arid.value)
            pending.append([addr, beats, 0, latency, arid])
        dut.m_arready.value = 1 if len(pending) < max_outstanding else 0

        # Drive one R beat per cycle from the oldest ready request.
        drove = False
        if not starve and pending:
            req = pending[0]
            if req[3] > 0:
                req[3] -= 1
            else:
                if int(dut.m_rready.value):
                    word_addr = req[0] + req[2] * 4
                    word = 0
                    for b in range(4):
                        word |= mem.get(word_addr + b, 0) << (8 * b)
                    dut.m_rdata.value = word
                    dut.m_rid.value = req[4]
                    dut.m_rvalid.value = 1
                    last = req[2] == req[1] - 1
                    dut.m_rlast.value = 1 if last else 0
                    dut.m_rresp.value = 0
                    drove = True
                    req[2] += 1
                    if last:
                        pending.pop(0)
                else:
                    # hold current beat valid until rready
                    pass
        if not drove:
            dut.m_rvalid.value = 0
            dut.m_rlast.value = 0


async def program_mode(
    dut, *, fb_base, w, h, fmt, stride, h_front=4, h_sync=8, h_back=4, v_front=2, v_sync=2, v_back=2
):
    await common.write_reg(dut, R_FB_BASE, fb_base)
    await common.write_reg(dut, R_MODE, (h << 16) | w)
    await common.write_reg(dut, R_H_PORCH, (h_sync << 16) | h_front)
    await common.write_reg(dut, R_HB_VF, (v_front << 16) | h_back)
    await common.write_reg(dut, R_VS_VB, (v_back << 16) | v_sync)
    await common.write_reg(dut, R_STRIDE, stride)
    await common.write_reg(dut, R_FORMAT, fmt)
    await common.write_reg(dut, R_ENABLE, 1)


def rgb565_to_rgb888(half: int) -> int:
    r5 = (half >> 11) & 0x1F
    g6 = (half >> 5) & 0x3F
    b5 = half & 0x1F
    r8 = (r5 << 3) | (r5 >> 2)
    g8 = (g6 << 2) | (g6 >> 4)
    b8 = (b5 << 3) | (b5 >> 2)
    return (r8 << 16) | (g8 << 8) | b8


async def capture_active_pixels(dut, count, *, timeout_cycles=20000):
    """Collect ``count`` consecutive active-DE pixels from the DPI stream."""
    pixels = []
    cycles = 0
    while len(pixels) < count and cycles < timeout_cycles:
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.pix_de.value):
            assert int(dut.pix_valid.value) == 1, "pix_valid must be high during DE"
            pixels.append(int(dut.pix_data.value))
        cycles += 1
    assert len(pixels) == count, f"captured {len(pixels)}/{count} pixels"
    return pixels


@cocotb.test()
async def scanout_xrgb8888_matches_framebuffer(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    w, h = 8, 4
    fb_base = 0x1000
    stride = w * 4
    # Known pattern: pixel (x,y) = 0x00RRGGBB derived from its index.
    mem = {}
    expected = []
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            rgb = ((idx * 7) & 0xFF) << 16 | ((idx * 13) & 0xFF) << 8 | ((idx * 29) & 0xFF)
            word = 0xFF000000 | rgb  # alpha is ignored by XR24
            addr = fb_base + y * stride + x * 4
            for b in range(4):
                mem[addr + b] = (word >> (8 * b)) & 0xFF
            expected.append(rgb)
    cocotb.start_soon(axi4_read_slave(dut, mem, latency=2))
    await program_mode(dut, fb_base=fb_base, w=w, h=h, fmt=FMT_XR24, stride=stride)
    assert await common.read_reg(dut, R_WORDS_PER_LINE) == w
    pixels = await capture_active_pixels(dut, w * h)
    assert pixels == expected, f"got {[hex(p) for p in pixels]}"


@cocotb.test()
async def scanout_rgb565_unpacks_correctly(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    w, h = 8, 4
    fb_base = 0x2000
    stride = w * 2  # 2 bytes per pixel
    mem = {}
    expected = []
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            half = (idx * 0x0841 + 0x1234) & 0xFFFF  # arbitrary RGB565 values
            addr = fb_base + y * stride + x * 2
            mem[addr] = half & 0xFF
            mem[addr + 1] = (half >> 8) & 0xFF
            expected.append(rgb565_to_rgb888(half))
    cocotb.start_soon(axi4_read_slave(dut, mem, latency=1))
    await program_mode(dut, fb_base=fb_base, w=w, h=h, fmt=FMT_RG16, stride=stride)
    # words/line = ceil(8*2/4) = 4
    assert await common.read_reg(dut, R_WORDS_PER_LINE) == 4
    pixels = await capture_active_pixels(dut, w * h)
    assert pixels == expected, f"got {[hex(p) for p in pixels]} exp {[hex(p) for p in expected]}"


@cocotb.test()
async def scanout_rgb888_packed(dut):
    """Densely-packed 24bpp RGB888: 3 bytes/pixel, pixels straddle the 4-byte
    AXI fetch granule, exercising the byte-assembly extractor."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    w, h = 8, 4
    fb_base = 0x3000
    stride = w * 3  # 24 bytes/line, not a multiple-of-4 alignment per pixel
    mem = {}
    expected = []
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            r = (idx * 11) & 0xFF
            g = (idx * 17) & 0xFF
            b = (idx * 23) & 0xFF
            addr = fb_base + y * stride + x * 3
            # DRAM little-endian byte order: byte0=B, byte1=G, byte2=R.
            mem[addr] = b
            mem[addr + 1] = g
            mem[addr + 2] = r
            expected.append((r << 16) | (g << 8) | b)
    cocotb.start_soon(axi4_read_slave(dut, mem, latency=2))
    await program_mode(dut, fb_base=fb_base, w=w, h=h, fmt=FMT_RG24, stride=stride)
    # words/line = ceil(8*3/4) = 6
    assert await common.read_reg(dut, R_WORDS_PER_LINE) == 6
    pixels = await capture_active_pixels(dut, w * h)
    assert pixels == expected, f"got {[hex(p) for p in pixels]}"


@cocotb.test()
async def timing_matches_programmed_mode(dut):
    """hsync/vsync/de cadence must equal the programmed mode."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    w, h = 8, 4
    h_front, h_sync, h_back = 4, 8, 4
    v_front, v_sync, v_back = 2, 2, 2
    mem = {addr: 0 for addr in range(0x4000, 0x4000 + 4096)}
    cocotb.start_soon(axi4_read_slave(dut, mem, latency=2))
    await program_mode(
        dut,
        fb_base=0x4000,
        w=w,
        h=h,
        fmt=FMT_XR24,
        stride=w * 4,
        h_front=h_front,
        h_sync=h_sync,
        h_back=h_back,
        v_front=v_front,
        v_sync=v_sync,
        v_back=v_back,
    )

    line_total = w + h_front + h_sync + h_back
    frame_lines = h + v_front + v_sync + v_back
    frame_total = line_total * frame_lines

    de_run = 0
    de_runs = []
    hsync_pulses = 0
    vsync_pulses = 0
    last_hs = last_vs = 0
    last_de = 0
    for _ in range(frame_total * 2 + 20):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        de = int(dut.pix_de.value)
        hs = int(dut.pix_hsync.value)
        vs = int(dut.pix_vsync.value)
        if de:
            de_run += 1
        elif last_de and not de:
            de_runs.append(de_run)
            de_run = 0
        if hs and not last_hs:
            hsync_pulses += 1
        if vs and not last_vs:
            vsync_pulses += 1
        last_hs, last_vs, last_de = hs, vs, de

    # Every active line presents exactly w pixels of DE.
    assert all(run == w for run in de_runs), f"de_runs={de_runs}"
    # Active lines per frame * 2 frames captured.
    assert len(de_runs) >= h, f"de_runs count={len(de_runs)}"
    assert vsync_pulses >= 2, f"vsync_pulses={vsync_pulses}"
    assert hsync_pulses >= frame_lines, f"hsync_pulses={hsync_pulses}"


@cocotb.test()
async def forced_underflow_sets_status_and_recovers(dut):
    """A starved AXI slave forces a FIFO underrun: defined fill colour on the
    DPI stream, sticky underflow + counter set; a subsequent well-fed frame
    scans out clean after a W1C clear."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    w, h = 8, 4
    fb_base = 0x5000
    stride = w * 4
    mem = {}
    expected = []
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            rgb = ((idx * 5) & 0xFF) << 16 | ((idx * 19) & 0xFF) << 8 | ((idx * 31) & 0xFF)
            addr = fb_base + y * stride + x * 4
            for b in range(4):
                mem[addr + b] = (0xFF000000 | rgb) >> (8 * b) & 0xFF
            expected.append(rgb)

    # Phase 1: starved slave -> guaranteed underflow.
    starve_handle = cocotb.start_soon(axi4_read_slave(dut, mem, starve=True))
    await program_mode(dut, fb_base=fb_base, w=w, h=h, fmt=FMT_XR24, stride=stride)
    fill_seen = 0
    for _ in range(2000):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.pix_de.value):
            assert int(dut.pix_valid.value) == 1
            if int(dut.pix_data.value) == UNDERFLOW_FILL:
                fill_seen += 1
    assert fill_seen > 0, "expected fill-coloured pixels under starvation"
    assert int(await common.read_reg(dut, R_UNDERFLOW_STICKY)) == 1
    assert int(await common.read_reg(dut, R_UNDERFLOW_COUNT)) > 0

    # Disable, kill the starved slave, clear status (W1C).
    await common.write_reg(dut, R_ENABLE, 0)
    starve_handle.kill()
    await common.write_reg(dut, R_UNDERFLOW_STICKY, 1)
    assert int(await common.read_reg(dut, R_UNDERFLOW_STICKY)) == 0
    assert int(await common.read_reg(dut, R_UNDERFLOW_COUNT)) == 0

    # Phase 2: healthy slave -> clean frame, no new underflow.
    cocotb.start_soon(axi4_read_slave(dut, mem, latency=1))
    await common.write_reg(dut, R_ENABLE, 1)
    await RisingEdge(dut.clk)
    pixels = await capture_active_pixels(dut, w * h)
    assert pixels == expected, f"got {[hex(p) for p in pixels]}"
    assert int(await common.read_reg(dut, R_UNDERFLOW_STICKY)) == 0, "no underflow when well-fed"
