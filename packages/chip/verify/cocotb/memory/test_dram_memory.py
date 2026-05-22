"""e1_dram_ctrl memory-controller boundary verification.

Drives the controller's AXI4 slave port directly (verify/cocotb/memory/
e1_dram_ctrl_mem_tb.sv) and proves the controller is a real large-memory
boundary, not a tiny SRAM aperture:

  * burst_write_read_back_across_row_boundary  — INCR burst write then
    read-back across a DRAM row boundary returns the written data.
  * multiple_outstanding_writes                — several AW are accepted
    before earlier B responses drain (write-response FIFO).
  * multiple_outstanding_reads                 — several AR are accepted
    before earlier R bursts drain (AR command FIFO).
  * backpressure_honored                       — when the master withholds
    s_rready / s_bready the controller stalls and never drops data.
  * boot_memtest_walking_ones_and_addr_in_addr — a boot-style memtest sweep
    (walking-ones + address-in-address) over a representative window.
  * out_of_range_read_returns_decerr           — a read beyond the 2 GiB
    aperture returns RESP_DECERR (fail-closed).
  * out_of_range_write_returns_decerr          — a write beyond the aperture
    returns RESP_DECERR.
  * capacity_readback_matches_geometry         — mem_base_addr /
    mem_capacity_bytes advertise 0x8000_0000 + 2 GiB for boot discovery.

The backing store is a sim-only sparse model; the AXI4 front-end + scheduler
under test is real RTL.  The LPDDR5X analog PHY behind the modelled DFI
boundary is a physical/silicon dependency and is out of scope here.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

RESP_OKAY = 0
RESP_SLVERR = 2
RESP_DECERR = 3

BURST_FIXED = 0
BURST_INCR = 1
BURST_WRAP = 2

DATA_WIDTH = 128
BYTES_PER_BEAT = DATA_WIDTH // 8
DATA_MASK = (1 << DATA_WIDTH) - 1
FULL_STRB = (1 << BYTES_PER_BEAT) - 1
SIZE_BEAT = BYTES_PER_BEAT.bit_length() - 1  # full-width beat AxSIZE

MEM_BASE = 0x8000_0000
MEM_CAP = 0x8000_0000  # 2 GiB


async def reset(dut):
    dut.rst_n.value = 0
    dut.s_awvalid.value = 0
    dut.s_wvalid.value = 0
    dut.s_bready.value = 0
    dut.s_arvalid.value = 0
    dut.s_rready.value = 0
    dut.s_awid.value = 0
    dut.s_arid.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


async def send_aw(dut, awid, addr, beats, size=SIZE_BEAT, burst=BURST_INCR):
    dut.s_awid.value = awid
    dut.s_awaddr.value = addr
    dut.s_awlen.value = beats - 1
    dut.s_awsize.value = size
    dut.s_awburst.value = burst
    dut.s_awlock.value = 0
    dut.s_awcache.value = 0xF
    dut.s_awprot.value = 0x2
    dut.s_awqos.value = 0
    dut.s_awuser.value = 0
    dut.s_awvalid.value = 1
    while True:
        await RisingEdge(dut.clk)
        if int(dut.s_awready.value):
            break
    dut.s_awvalid.value = 0


async def send_w(dut, data_list, strb=FULL_STRB):
    n = len(data_list)
    for i, data in enumerate(data_list):
        dut.s_wdata.value = data & DATA_MASK
        dut.s_wstrb.value = strb
        dut.s_wlast.value = 1 if i == n - 1 else 0
        dut.s_wvalid.value = 1
        while True:
            await RisingEdge(dut.clk)
            if int(dut.s_wready.value):
                break
        dut.s_wvalid.value = 0
        await RisingEdge(dut.clk)
    dut.s_wlast.value = 0


async def collect_b(dut, timeout=8192):
    dut.s_bready.value = 1
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        if int(dut.s_bvalid.value):
            resp = int(dut.s_bresp.value)
            bid = int(dut.s_bid.value)
            dut.s_bready.value = 0
            return resp, bid
    dut.s_bready.value = 0
    raise TimeoutError("no B response")


async def write_burst(dut, awid, addr, data_list, strb=FULL_STRB, burst=BURST_INCR):
    await send_aw(dut, awid, addr, len(data_list), burst=burst)
    await send_w(dut, data_list, strb=strb)
    return await collect_b(dut)


async def read_burst(dut, arid, addr, beats, burst=BURST_INCR, rready=1, timeout=20000):
    dut.s_arid.value = arid
    dut.s_araddr.value = addr
    dut.s_arlen.value = beats - 1
    dut.s_arsize.value = SIZE_BEAT
    dut.s_arburst.value = burst
    dut.s_arlock.value = 0
    dut.s_arcache.value = 0xF
    dut.s_arprot.value = 0x2
    dut.s_arqos.value = 0
    dut.s_aruser.value = 0
    dut.s_arvalid.value = 1
    while True:
        await RisingEdge(dut.clk)
        if int(dut.s_arready.value):
            break
    dut.s_arvalid.value = 0

    dut.s_rready.value = rready
    out = []
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        if int(dut.s_rvalid.value) and int(dut.s_rready.value):
            out.append(
                (
                    int(dut.s_rdata.value),
                    int(dut.s_rresp.value),
                    int(dut.s_rlast.value),
                    int(dut.s_rid.value),
                )
            )
            if int(dut.s_rlast.value):
                break
    dut.s_rready.value = 0
    return out


@cocotb.test()
async def capacity_readback_matches_geometry(dut):
    """mem_base_addr / mem_capacity_bytes advertise the discoverable
    geometry boot firmware reads to size RAM (no panic on mem= mismatch)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    base = int(dut.mem_base_addr.value)
    cap = int(dut.mem_capacity_bytes.value)
    assert base == MEM_BASE, f"base {hex(base)} != {hex(MEM_BASE)}"
    assert cap == MEM_CAP, f"capacity {hex(cap)} != {hex(MEM_CAP)} (expected 2 GiB)"
    assert cap >= (2 * 1024 * 1024 * 1024), "capacity must be >= 2 GiB"


@cocotb.test()
async def burst_write_read_back_across_row_boundary(dut):
    """INCR write then read-back across a DRAM row boundary (ROW_ADDR_LSB=16,
    so a row spans 64 KiB).  Place the burst so beats straddle the 64 KiB
    boundary, forcing a row-miss on read-back of the second half."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    beats = 8
    # Start one row below a 64 KiB boundary so the burst crosses it.
    row_boundary = MEM_BASE + 0x1_0000
    base = row_boundary - (beats // 2) * BYTES_PER_BEAT
    data = [(0xCAFE_0000_0000_0000 + i) | (i << 96) for i in range(beats)]
    resp, _ = await write_burst(dut, 0x1, base, data)
    assert resp == RESP_OKAY, f"write bresp={resp}"
    rd = await read_burst(dut, 0x1, base, beats)
    assert len(rd) == beats, f"got {len(rd)} beats"
    for i, (d, r, last, rid) in enumerate(rd):
        assert r == RESP_OKAY, f"beat {i} resp={r}"
        assert rid == 0x1
        assert (d & DATA_MASK) == (data[i] & DATA_MASK), f"beat {i} mismatch"
        assert last == (1 if i == beats - 1 else 0)


@cocotb.test()
async def multiple_outstanding_writes(dut):
    """Several AW are accepted before B responses are collected: the
    write-response FIFO holds completions while the AW channel keeps
    accepting new bursts."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    n = 4
    base = MEM_BASE + 0x2_0000
    # Issue n single-beat writes back to back, do NOT collect B between them.
    for k in range(n):
        await send_aw(dut, 0x2, base + k * 0x1000, 1)
        await send_w(dut, [(0xA000_0000 + k)])
    # Now drain n B responses.
    got = 0
    dut.s_bready.value = 1
    for _ in range(8192):
        await RisingEdge(dut.clk)
        if int(dut.s_bvalid.value):
            assert int(dut.s_bresp.value) == RESP_OKAY
            got += 1
            if got == n:
                break
    dut.s_bready.value = 0
    assert got == n, f"only drained {got}/{n} write responses"
    # Read back each to confirm data integrity under outstanding writes.
    for k in range(n):
        rd = await read_burst(dut, 0x2, base + k * 0x1000, 1)
        assert (rd[0][0] & 0xFFFF_FFFF) == (0xA000_0000 + k)


@cocotb.test()
async def multiple_outstanding_reads(dut):
    """Several AR are accepted into the AR command FIFO before any R data is
    consumed: arready stays high for multiple back-to-back AR while rready
    is held low."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    n = 4
    base = MEM_BASE + 0x3_0000
    for k in range(n):
        await write_burst(dut, 0x3, base + k * 0x1000, [(0xB000_0000 + k)])

    # Hold rready low, fire n AR; count how many AR handshakes complete.
    dut.s_rready.value = 0
    accepted = 0
    for k in range(n):
        dut.s_arid.value = 0x3
        dut.s_araddr.value = base + k * 0x1000
        dut.s_arlen.value = 0
        dut.s_arsize.value = SIZE_BEAT
        dut.s_arburst.value = BURST_INCR
        dut.s_arlock.value = 0
        dut.s_arcache.value = 0xF
        dut.s_arprot.value = 0x2
        dut.s_arqos.value = 0
        dut.s_aruser.value = 0
        dut.s_arvalid.value = 1
        hit = False
        for _ in range(64):
            await RisingEdge(dut.clk)
            if int(dut.s_arready.value):
                hit = True
                break
        dut.s_arvalid.value = 0
        await RisingEdge(dut.clk)
        if hit:
            accepted += 1
    assert accepted >= 2, f"expected >=2 outstanding AR accepted, got {accepted}"

    # Now drain all the read data and check ordering/integrity.
    dut.s_rready.value = 1
    seen = []
    for _ in range(20000):
        await RisingEdge(dut.clk)
        if int(dut.s_rvalid.value) and int(dut.s_rready.value):
            seen.append(int(dut.s_rdata.value) & 0xFFFF_FFFF)
            if len(seen) == accepted:
                break
    dut.s_rready.value = 0
    for k in range(accepted):
        assert seen[k] == (0xB000_0000 + k), f"read FIFO order beat {k}: {hex(seen[k])}"


@cocotb.test()
async def backpressure_honored(dut):
    """When the master withholds rready mid-burst the controller must stall
    s_rvalid/s_rdata and resume the exact same beat once rready returns —
    no data dropped, no extra beats."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    beats = 6
    base = MEM_BASE + 0x4_0000
    data = [(0xD000_0000 + i) for i in range(beats)]
    await write_burst(dut, 0x4, base, data)

    # Read with a stutter: pulse rready so the controller has to hold each
    # beat until accepted.
    dut.s_arid.value = 0x4
    dut.s_araddr.value = base
    dut.s_arlen.value = beats - 1
    dut.s_arsize.value = SIZE_BEAT
    dut.s_arburst.value = BURST_INCR
    dut.s_arlock.value = 0
    dut.s_arcache.value = 0xF
    dut.s_arprot.value = 0x2
    dut.s_arqos.value = 0
    dut.s_aruser.value = 0
    dut.s_arvalid.value = 1
    while True:
        await RisingEdge(dut.clk)
        if int(dut.s_arready.value):
            break
    dut.s_arvalid.value = 0

    collected = []
    cycles = 0
    while len(collected) < beats and cycles < 20000:
        # rready toggles every other beat-attempt to create backpressure.
        dut.s_rready.value = 1 if (cycles % 3 == 0) else 0
        await RisingEdge(dut.clk)
        cycles += 1
        if int(dut.s_rvalid.value) and int(dut.s_rready.value):
            collected.append(int(dut.s_rdata.value) & 0xFFFF_FFFF)
        # While rvalid is up but rready low, data must be held stable.
        if int(dut.s_rvalid.value) and not int(dut.s_rready.value) and collected:
            held = int(dut.s_rdata.value) & 0xFFFF_FFFF
            assert held == data[len(collected)], "held beat changed under backpressure"
    dut.s_rready.value = 0
    assert collected == data, f"backpressure corrupted data: {[hex(x) for x in collected]}"


@cocotb.test()
async def boot_memtest_walking_ones_and_addr_in_addr(dut):
    """Boot-style memtest sweep over a representative window:
    1. address-in-address: write each beat's own address, read it all back.
    2. walking-ones: each of a set of bit positions written/read at distinct
       addresses.  Mirrors what U-Boot/Linux memtest does to qualify RAM."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    window_base = MEM_BASE + 0x10_0000
    n_lines = 64  # representative window: 64 cache lines

    # --- address-in-address pattern -------------------------------------
    for i in range(n_lines):
        addr = window_base + i * BYTES_PER_BEAT
        await write_burst(dut, 0x5, addr, [addr & DATA_MASK])
    for i in range(n_lines):
        addr = window_base + i * BYTES_PER_BEAT
        rd = await read_burst(dut, 0x5, addr, 1)
        assert rd[0][1] == RESP_OKAY
        assert (rd[0][0] & DATA_MASK) == (addr & DATA_MASK), (
            f"addr-in-addr fail at {hex(addr)}: got {hex(rd[0][0] & DATA_MASK)}"
        )

    # --- walking-ones pattern -------------------------------------------
    for bit in range(0, DATA_WIDTH, 8):  # sample every 8th bit position
        addr = window_base + 0x4000 + bit * BYTES_PER_BEAT
        pattern = (1 << bit) & DATA_MASK
        await write_burst(dut, 0x6, addr, [pattern])
        rd = await read_burst(dut, 0x6, addr, 1)
        assert rd[0][1] == RESP_OKAY
        assert (rd[0][0] & DATA_MASK) == pattern, (
            f"walking-ones bit {bit} fail: got {hex(rd[0][0] & DATA_MASK)}"
        )


@cocotb.test()
async def out_of_range_read_returns_decerr(dut):
    """A read above MEM_BASE + 2 GiB must return RESP_DECERR (fail-closed)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    oob = MEM_BASE + MEM_CAP + 0x1000  # one page past the top of RAM
    rd = await read_burst(dut, 0x7, oob, 1)
    assert rd, "no R beat on OOB read"
    assert rd[0][1] == RESP_DECERR, f"expected DECERR, got {rd[0][1]}"
    assert rd[0][2] == 1, "OOB read beat must be rlast"


@cocotb.test()
async def out_of_range_write_returns_decerr(dut):
    """A write above the aperture must return RESP_DECERR on B."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    oob = MEM_BASE + MEM_CAP + 0x2000
    resp, _ = await write_burst(dut, 0x8, oob, [(0xDEAD_0000)])
    assert resp == RESP_DECERR, f"expected DECERR on OOB write, got {resp}"

    # Below the base is also out of range.
    below = MEM_BASE - 0x1000
    resp2, _ = await write_burst(dut, 0x8, below, [(0xBEEF_0000)])
    assert resp2 == RESP_DECERR, f"expected DECERR below base, got {resp2}"
