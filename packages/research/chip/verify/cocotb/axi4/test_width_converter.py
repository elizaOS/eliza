"""AXI4 width converter (e1_axi4_width_converter) verification.

Targets the upsizer direction (upstream 64-bit master into a downstream
128-bit slave) used by the SoC top to route CVA6 v5.3.0's native 64-bit
AXI master into the cluster slot 0 per-core port (which is 128-bit to
match the L1D cache line width).

Coverage:

* Single-beat 64-bit write -> single 128-bit downstream beat with the
  correct lane-shifted WSTRB.
* Single-beat 64-bit read -> single 128-bit downstream beat muxed back
  to the upstream lane.
* Multi-beat INCR write burst (4 beats) with address-incrementing lanes.
* Multi-beat INCR read burst.
* WSTRB byte-mask placement on the high lane (addr[3]=1).
* Read-response merge from the downstream lane select onto upstream.
* Back-to-back transactions (single inflight FSM does not stall the
  next transaction once B/R complete).
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# Constants
RESP_OKAY = 0
BURST_INCR = 1

UP_DATA_W = 64
DN_DATA_W = 128
UP_BYTES = UP_DATA_W // 8
DN_BYTES = DN_DATA_W // 8


async def reset(dut):
    dut.rst_n.value = 0
    dut.up_aw_valid.value = 0
    dut.up_w_valid.value = 0
    dut.up_b_ready.value = 0
    dut.up_ar_valid.value = 0
    dut.up_r_ready.value = 0
    dut.up_aw_atop.value = 0
    dut.up_aw_lock.value = 0
    dut.up_aw_cache.value = 0
    dut.up_aw_prot.value = 0
    dut.up_aw_qos.value = 0
    dut.up_aw_region.value = 0
    dut.up_aw_user.value = 0
    dut.up_aw_burst.value = BURST_INCR
    dut.up_ar_lock.value = 0
    dut.up_ar_cache.value = 0
    dut.up_ar_prot.value = 0
    dut.up_ar_qos.value = 0
    dut.up_ar_region.value = 0
    dut.up_ar_user.value = 0
    dut.up_ar_burst.value = BURST_INCR
    dut.up_w_user.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


async def upstream_write(dut, awid, addr, beats, size=3):
    """Issue an AXI4 write burst on the upstream port.

    ``beats`` is a list of (data, strb) tuples in upstream-width units.
    size: log2(bytes per beat) at upstream side.  Default 3 = 8 bytes.
    Returns (bresp, bid).
    """
    dut.up_aw_id.value = awid
    dut.up_aw_addr.value = addr
    dut.up_aw_len.value = len(beats) - 1
    dut.up_aw_size.value = size
    dut.up_aw_valid.value = 1
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.up_aw_ready.value):
            break
    else:
        raise AssertionError("AW never ready")
    dut.up_aw_valid.value = 0

    for i, (data, strb) in enumerate(beats):
        dut.up_w_data.value = data
        dut.up_w_strb.value = strb
        dut.up_w_last.value = 1 if i == len(beats) - 1 else 0
        dut.up_w_valid.value = 1
        for _ in range(512):
            await RisingEdge(dut.clk)
            if int(dut.up_w_ready.value):
                break
        else:
            raise AssertionError(f"W never ready at beat {i}")
        dut.up_w_valid.value = 0
        await RisingEdge(dut.clk)
    dut.up_w_last.value = 0

    dut.up_b_ready.value = 1
    bresp = None
    bid = None
    for _ in range(4096):
        await RisingEdge(dut.clk)
        if int(dut.up_b_valid.value):
            bresp = int(dut.up_b_resp.value)
            bid = int(dut.up_b_id.value)
            break
    dut.up_b_ready.value = 0
    return bresp, bid


async def upstream_read(dut, arid, addr, length, size=3):
    dut.up_ar_id.value = arid
    dut.up_ar_addr.value = addr
    dut.up_ar_len.value = length - 1
    dut.up_ar_size.value = size
    dut.up_ar_valid.value = 1
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.up_ar_ready.value):
            break
    else:
        raise AssertionError("AR never ready")
    dut.up_ar_valid.value = 0

    dut.up_r_ready.value = 1
    beats = []
    for _ in range(length * 256 + 256):
        await RisingEdge(dut.clk)
        if int(dut.up_r_valid.value):
            data = int(dut.up_r_data.value)
            resp = int(dut.up_r_resp.value)
            last = int(dut.up_r_last.value)
            rid = int(dut.up_r_id.value)
            beats.append((data, resp, last, rid))
            if last:
                break
    dut.up_r_ready.value = 0
    return beats


@cocotb.test()
async def single_beat_64_to_128_write_then_read(dut):
    """One 64-bit upstream beat -> one 128-bit downstream beat (low lane).

    addr=0x1000 (DN-aligned, low 64-bit lane).  Read it back; the
    upstream receives the same 64-bit value.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    payload = 0xDEAD_BEEF_CAFE_F00D
    bresp, bid = await upstream_write(dut, 0x3, 0x1000, [(payload, full_strb_up)])
    assert bresp == RESP_OKAY
    assert bid == 0x3

    # Read it back.
    rd = await upstream_read(dut, 0x3, 0x1000, 1)
    assert len(rd) == 1
    data, resp, last, rid = rd[0]
    assert resp == RESP_OKAY
    assert last == 1
    assert rid == 0x3
    assert data & ((1 << UP_DATA_W) - 1) == payload, (
        f"read mismatch: got {data:016x}, want {payload:016x}"
    )


@cocotb.test()
async def single_beat_high_lane_address_uses_strb_offset(dut):
    """addr[3]=1 puts the 64-bit data on the high lane of the 128-bit beat.

    Read-back must restore the 64-bit value to the upstream lane.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    payload = 0xA5A5_DEAD_0000_1111
    # addr=0x2008 -> low 4 bits = 0x8, byte-lane offset = 8, lane index = 1.
    bresp, _ = await upstream_write(dut, 0x4, 0x2008, [(payload, full_strb_up)])
    assert bresp == RESP_OKAY

    rd = await upstream_read(dut, 0x4, 0x2008, 1)
    assert len(rd) == 1
    data, resp, last, rid = rd[0]
    assert resp == RESP_OKAY
    assert last == 1
    assert rid == 0x4
    assert data & ((1 << UP_DATA_W) - 1) == payload, (
        f"high-lane read mismatch: got {data:016x}, want {payload:016x}"
    )


@cocotb.test()
async def multi_beat_write_burst_increments_lane(dut):
    """4-beat INCR write at addr 0x3000.

    Beats land on lanes 0, 1, 0, 1 (alternating since 64<<128 ratio is 2).
    Read-back via 4 separate single-beat reads to avoid burst-collect
    behaviour and confirm each underlying memory word.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    beats = [(0x1111_0000_0000_0000 + i, full_strb_up) for i in range(4)]
    bresp, _ = await upstream_write(dut, 0x5, 0x3000, beats)
    assert bresp == RESP_OKAY

    # The slave memory is 128-bit indexed.  Beats 0 and 1 land in mem[0x300]
    # (low and high lanes); beats 2 and 3 land in mem[0x301].  Confirm
    # by reading 4 single-beat 64-bit values.
    for i in range(4):
        rd = await upstream_read(dut, 0x5, 0x3000 + i * 8, 1)
        assert len(rd) == 1
        data, _, _, _ = rd[0]
        want = 0x1111_0000_0000_0000 + i
        assert data & ((1 << UP_DATA_W) - 1) == want, (
            f"beat {i} mismatch: got {data:016x}, want {want:016x}"
        )


@cocotb.test()
async def multi_beat_read_burst_returns_all_beats(dut):
    """Multi-beat AR with length 4 returns 4 upstream beats."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    # Prime memory with single-beat writes so we know the layout.
    for i in range(4):
        bresp, _ = await upstream_write(
            dut, 0x6, 0x4000 + i * 8, [(0xCAFE_0000_0000_0000 + i, full_strb_up)]
        )
        assert bresp == RESP_OKAY

    rd = await upstream_read(dut, 0x6, 0x4000, 4)
    assert len(rd) == 4
    for i, (data, resp, last, rid) in enumerate(rd):
        assert resp == RESP_OKAY
        assert rid == 0x6
        assert last == (1 if i == 3 else 0)
        want = 0xCAFE_0000_0000_0000 + i
        assert data & ((1 << UP_DATA_W) - 1) == want, (
            f"burst-read beat {i} mismatch: got {data:016x}, want {want:016x}"
        )


@cocotb.test()
async def partial_wstrb_preserves_unwritten_bytes(dut):
    """Write 64-bit pattern, then overwrite byte 0 only via WSTRB."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    pattern = sum(0xAA << (8 * b) for b in range(UP_BYTES))  # 0xAAAAAAAAAAAAAAAA
    await upstream_write(dut, 0x7, 0x5000, [(pattern, full_strb_up)])

    # Now overwrite byte 0 only with 0xC3.
    new_word = (pattern & ~0xFF) | 0xC3
    await upstream_write(dut, 0x7, 0x5000, [(new_word, 0x01)])

    rd = await upstream_read(dut, 0x7, 0x5000, 1)
    data = rd[0][0] & ((1 << UP_DATA_W) - 1)
    assert (data & 0xFF) == 0xC3, f"byte 0 wrong: {data & 0xFF:02x}"
    assert ((data >> 8) & 0xFF) == 0xAA, f"byte 1 changed: {(data >> 8) & 0xFF:02x}"
    assert ((data >> 56) & 0xFF) == 0xAA, f"byte 7 changed: {(data >> 56) & 0xFF:02x}"


@cocotb.test()
async def burst_length_passthrough(dut):
    """AWLEN and ARLEN must be passed through for the upsize path.

    AXI4 A8.4.1 says narrow-to-wide upsizing keeps AxLEN/AxSIZE intact
    when the upstream master AxSIZE is smaller than the downstream bus
    width.  Confirm via the observability outputs.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    # Issue a 4-beat AW; observe dbg_dn_aw_len mid-handshake.
    dut.up_aw_id.value = 0x8
    dut.up_aw_addr.value = 0x6000
    dut.up_aw_len.value = 3  # 4 beats
    dut.up_aw_size.value = 3
    dut.up_aw_valid.value = 1
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.up_aw_ready.value):
            assert int(dut.dbg_dn_aw_len.value) == 3, (
                f"AWLEN not preserved: {int(dut.dbg_dn_aw_len.value)}"
            )
            assert int(dut.dbg_dn_aw_size.value) == 3, (
                f"AWSIZE not preserved: {int(dut.dbg_dn_aw_size.value)}"
            )
            break
    else:
        raise AssertionError("AW never accepted")
    dut.up_aw_valid.value = 0

    # Drain the W beats so the slave releases its AW slot.
    for i in range(4):
        dut.up_w_data.value = 0x1234_5678_9ABC_DEF0 + i
        dut.up_w_strb.value = full_strb_up
        dut.up_w_last.value = 1 if i == 3 else 0
        dut.up_w_valid.value = 1
        for _ in range(64):
            await RisingEdge(dut.clk)
            if int(dut.up_w_ready.value):
                break
        dut.up_w_valid.value = 0
        await RisingEdge(dut.clk)
    dut.up_w_last.value = 0
    dut.up_b_ready.value = 1
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.up_b_valid.value):
            break
    dut.up_b_ready.value = 0


@cocotb.test()
async def back_to_back_writes_single_inflight(dut):
    """After B handshake completes, the next AW must be accepted.

    Verifies the single-inflight FSM correctly releases the pending
    flag once B fires.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    full_strb_up = (1 << UP_BYTES) - 1

    for i in range(3):
        bresp, _ = await upstream_write(
            dut, 0x9, 0x7000 + i * 16, [(0xBEEF_0000 + i, full_strb_up)]
        )
        assert bresp == RESP_OKAY, f"iteration {i} got bresp={bresp}"
    # Now read back to ensure data integrity.
    for i in range(3):
        rd = await upstream_read(dut, 0x9, 0x7000 + i * 16, 1)
        data = rd[0][0] & ((1 << UP_DATA_W) - 1)
        assert data == (0xBEEF_0000 + i), (
            f"back-to-back read {i} mismatch: got {data:016x}, want {(0xBEEF_0000 + i):016x}"
        )


@cocotb.test()
async def reset_quiesces_outputs(dut):
    """Asserting rst_n=0 must clear all downstream valids."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Drive nothing; sample.
    for _ in range(8):
        await RisingEdge(dut.clk)
    assert int(dut.dbg_dn_w_valid.value) == 0
    assert int(dut.up_b_valid.value) == 0
    assert int(dut.up_r_valid.value) == 0

    await Timer(50, units="ns")
