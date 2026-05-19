"""Write-1-to-clear MMR contract for the AXI4 interconnect IRQ status.

The interconnect latches two per-master IRQ vectors:

* ``decode_err_irq``      — set when a master issued a transaction to an
  address that decoded outside any slave aperture.
* ``exclusive_fail_irq``  — set when a foreign master invalidated a
  pending exclusive reservation.

Round-2 made the bits sticky-until-reset to keep them visible across the
B-response handshake, but a real OS driver needs to acknowledge IRQs
without rebooting the fabric.  This test exercises the write-1-to-clear
contract that round-3 added:

1. Trigger a decode error → confirm ``decode_err_irq[master]`` asserts and
   stays asserted across subsequent cycles.
2. Drive ``irq_status_clear_we`` for one cycle with the matching bit set
   in ``irq_status_decode_err_clear_mask`` → confirm the bit clears on
   the next cycle and stays low until a new edge fires.
3. Retrigger the decode error after the clear → confirm the bit reasserts
   (i.e. the clear did not latch the line low).
4. Repeat for ``exclusive_fail_irq`` via the established
   foreign-AW-invalidates-reservation path from round-2.

The MMIO address bindings live in docs/spec-db/axi4-interconnect-mmio.yaml.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

RESP_OKAY = 0
RESP_EXOKAY = 1
RESP_SLVERR = 2
RESP_DECERR = 3

BURST_INCR = 1

DATA_WIDTH = 128
BYTES_PER_BEAT = DATA_WIDTH // 8


async def reset(dut):
    dut.rst_n.value = 0
    dut.m_awvalid.value = 0
    dut.m_wvalid.value = 0
    dut.m_bready.value = 0
    dut.m_arvalid.value = 0
    dut.m_rready.value = 0
    dut.irq_status_clear_we.value = 0
    dut.irq_status_decode_err_clear_mask.value = 0
    dut.irq_status_excl_fail_clear_mask.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


async def axi4_write_burst(
    dut,
    master,
    awid,
    addr,
    beats,
    size=4,
    burst=BURST_INCR,
    lock=0,
    qos=0,
    cache=0x2,
    prot=0x2,
):
    bit = 1 << master
    dut.m_awid[master].value = awid
    dut.m_awaddr[master].value = addr
    dut.m_awlen[master].value = len(beats) - 1
    dut.m_awsize[master].value = size
    dut.m_awburst[master].value = burst
    dut.m_awlock[master].value = lock
    dut.m_awcache[master].value = cache
    dut.m_awprot[master].value = prot
    dut.m_awqos[master].value = qos
    dut.m_awuser[master].value = 0
    dut.m_awvalid.value = (int(dut.m_awvalid.value) & ~bit) | bit
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.m_awready.value) & bit:
            break
    dut.m_awvalid.value = int(dut.m_awvalid.value) & ~bit

    for i, (data, strb) in enumerate(beats):
        dut.m_wdata[master].value = data
        dut.m_wstrb[master].value = strb
        dut.m_wlast[master].value = 1 if i == len(beats) - 1 else 0
        dut.m_wvalid.value = (int(dut.m_wvalid.value) & ~bit) | bit
        for _ in range(512):
            await RisingEdge(dut.clk)
            if int(dut.m_wready.value) & bit:
                break
        dut.m_wvalid.value = int(dut.m_wvalid.value) & ~bit
        await RisingEdge(dut.clk)
    dut.m_wlast[master].value = 0

    dut.m_bready.value = int(dut.m_bready.value) | bit
    bresp = None
    bid = None
    for _ in range(4096):
        await RisingEdge(dut.clk)
        if int(dut.m_bvalid.value) & bit:
            bresp = int(dut.m_bresp[master].value)
            bid = int(dut.m_bid[master].value)
            break
    dut.m_bready.value = int(dut.m_bready.value) & ~bit
    return bresp, bid


async def axi4_read_burst(
    dut,
    master,
    arid,
    addr,
    length,
    size=4,
    burst=BURST_INCR,
    lock=0,
    qos=0,
    cache=0x2,
    prot=0x2,
):
    bit = 1 << master
    dut.m_arid[master].value = arid
    dut.m_araddr[master].value = addr
    dut.m_arlen[master].value = length - 1
    dut.m_arsize[master].value = size
    dut.m_arburst[master].value = burst
    dut.m_arlock[master].value = lock
    dut.m_arcache[master].value = cache
    dut.m_arprot[master].value = prot
    dut.m_arqos[master].value = qos
    dut.m_aruser[master].value = 0
    dut.m_arvalid.value = (int(dut.m_arvalid.value) & ~bit) | bit
    for _ in range(512):
        await RisingEdge(dut.clk)
        if int(dut.m_arready.value) & bit:
            break
    dut.m_arvalid.value = int(dut.m_arvalid.value) & ~bit

    dut.m_rready.value = int(dut.m_rready.value) | bit
    beats = []
    for _ in range(length * 256 + 256):
        await RisingEdge(dut.clk)
        if int(dut.m_rvalid.value) & bit:
            data = int(dut.m_rdata[master].value)
            resp = int(dut.m_rresp[master].value)
            last = int(dut.m_rlast[master].value) & bit
            rid = int(dut.m_rid[master].value)
            beats.append((data, resp, last, rid))
            if last:
                break
    dut.m_rready.value = int(dut.m_rready.value) & ~bit
    return beats


async def w1c_irq(dut, decode_err_mask=0, excl_fail_mask=0):
    """Drive the W1C clear protocol for one cycle, mirroring how a real
    MMIO writer would assert clear_we with the bits-to-clear."""
    dut.irq_status_decode_err_clear_mask.value = decode_err_mask
    dut.irq_status_excl_fail_clear_mask.value = excl_fail_mask
    dut.irq_status_clear_we.value = 1
    await RisingEdge(dut.clk)
    dut.irq_status_clear_we.value = 0
    dut.irq_status_decode_err_clear_mask.value = 0
    dut.irq_status_excl_fail_clear_mask.value = 0
    await RisingEdge(dut.clk)


@cocotb.test()
async def decode_err_irq_w1c_clears_status(dut):
    """A decode-err edge sets the sticky IRQ; a W1C write clears it; a
    second edge re-asserts it.  Without the clear, the bit must persist
    across multiple cycles."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Trigger decode error from master 0 — address 0xCAFE_0000 is unmapped.
    rd = await axi4_read_burst(dut, 0, 0x1, 0xCAFE_0000, 1)
    assert rd, "no read response on decode error"
    _, resp, _, _ = rd[0]
    assert resp == RESP_DECERR

    # The sticky IRQ must be visible for several cycles after the response.
    for _ in range(8):
        await RisingEdge(dut.clk)
        assert int(dut.decode_err_irq.value) & 0x1, "decode_err_irq[0] dropped while sticky"

    # Clear via W1C with master-0 bit set.
    await w1c_irq(dut, decode_err_mask=0x1)
    assert (int(dut.decode_err_irq.value) & 0x1) == 0, (
        "decode_err_irq[0] still asserted after W1C clear"
    )

    # And it stays clear when no new event fires.
    for _ in range(8):
        await RisingEdge(dut.clk)
        assert (int(dut.decode_err_irq.value) & 0x1) == 0, (
            "decode_err_irq[0] reasserted with no new fault"
        )

    # Retrigger the decode error — the bit must come back.
    rd = await axi4_read_burst(dut, 0, 0x2, 0xCAFE_1000, 1)
    assert rd
    assert int(dut.decode_err_irq.value) & 0x1, (
        "decode_err_irq[0] did not reassert after second fault"
    )


@cocotb.test()
async def excl_fail_irq_w1c_clears_status(dut):
    """ARLOCK reservation + foreign AW invalidates it → IRQ set; W1C
    clears it; a second reservation + foreign AW reasserts."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    size = int(BYTES_PER_BEAT).bit_length() - 1
    full_strb = (1 << BYTES_PER_BEAT) - 1

    # Establish a reservation from master 0.
    rd = await axi4_read_burst(dut, 0, 0xA, 0x9000, 1, size=size, lock=1)
    assert rd
    # Master 1 invalidates it.
    await axi4_write_burst(dut, 1, 0xB, 0x9000, [(0xDEAD, full_strb)], size=size)
    # Sticky IRQ should be visible for several cycles.
    for _ in range(8):
        await RisingEdge(dut.clk)
        assert int(dut.exclusive_fail_irq.value) & 0x1, "exclusive_fail_irq[0] dropped while sticky"

    # Clear via W1C.
    await w1c_irq(dut, excl_fail_mask=0x1)
    assert (int(dut.exclusive_fail_irq.value) & 0x1) == 0, (
        "exclusive_fail_irq[0] still asserted after W1C clear"
    )

    # Stays clear without retrigger.
    for _ in range(8):
        await RisingEdge(dut.clk)
        assert (int(dut.exclusive_fail_irq.value) & 0x1) == 0

    # Retrigger.
    rd = await axi4_read_burst(dut, 0, 0xC, 0xA000, 1, size=size, lock=1)
    assert rd
    await axi4_write_burst(dut, 1, 0xD, 0xA000, [(0xBEEF, full_strb)], size=size)
    assert int(dut.exclusive_fail_irq.value) & 0x1, (
        "exclusive_fail_irq[0] did not reassert after second invalidation"
    )


@cocotb.test()
async def w1c_clears_only_masked_bits(dut):
    """W1C with mask=0 leaves the sticky bit untouched even when
    clear_we is asserted.  This isolates the bit-mask semantics."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Set the decode-err bit.
    rd = await axi4_read_burst(dut, 0, 0x3, 0xBADC_0000, 1)
    assert rd
    assert int(dut.decode_err_irq.value) & 0x1

    # W1C with mask=0 (the clear bus pulses but no bits requested).
    await w1c_irq(dut, decode_err_mask=0x0, excl_fail_mask=0x0)
    assert int(dut.decode_err_irq.value) & 0x1, "decode_err_irq[0] should not clear when mask=0"

    # Now actually clear.
    await w1c_irq(dut, decode_err_mask=0x1)
    assert (int(dut.decode_err_irq.value) & 0x1) == 0
