"""cocotb suite for the production E1 PLIC (rtl/interrupts/e1_plic.sv).

The PLIC is the RISC-V Platform-Level Interrupt Controller: it routes device
external interrupts to the harts (mip.MEIP / mip.SEIP) with per-source priority,
per-context interrupt-enable, per-context priority threshold, and claim/complete
arbitration. Compatible with the riscv,plic0 / sifive,plic-1.0.0 DT binding.

This suite drives the module's 32-bit AXI-Lite slave at the RISC-V PLIC register
map (NUM_SOURCES=4, NUM_CONTEXTS=2 in the testbench) and asserts:
  * claim returns the highest-priority enabled pending source above threshold;
  * complete clears the in-service source and re-arms the gateway;
  * threshold masks sources whose priority does not exceed it;
  * a disabled source never reaches a context;
  * two contexts are isolated (enables/thresholds/claims are independent).

Register map (window-relative byte offsets):
    +0x000000 + 4*src               : priority[src]   RW32 (0..7)
    +0x001000                       : pending block 0 RO32 (bit s = source s)
    +0x002000 + 0x80*ctx            : enable[ctx]     RW32 (bit s = source s)
    +0x200000 + 0x1000*ctx + 0x0    : threshold[ctx]  RW32 (0..7)
    +0x200000 + 0x1000*ctx + 0x4    : claim/complete  R=claim, W=complete
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PRIO_BASE = 0x000000
PENDING0 = 0x001000
ENABLE_BASE = 0x002000
ENABLE_STRIDE = 0x80
CTX_BASE = 0x200000
CTX_STRIDE = 0x1000


def _prio(src: int) -> int:
    return PRIO_BASE + 4 * src


def _enable(ctx: int) -> int:
    return ENABLE_BASE + ENABLE_STRIDE * ctx


def _threshold(ctx: int) -> int:
    return CTX_BASE + CTX_STRIDE * ctx + 0x0


def _claim(ctx: int) -> int:
    return CTX_BASE + CTX_STRIDE * ctx + 0x4


async def _reset(dut):
    dut.rst_n.value = 0
    dut.s_axil_awvalid.value = 0
    dut.s_axil_awaddr.value = 0
    dut.s_axil_wvalid.value = 0
    dut.s_axil_wdata.value = 0
    dut.s_axil_wstrb.value = 0
    dut.s_axil_bready.value = 1
    dut.s_axil_arvalid.value = 0
    dut.s_axil_araddr.value = 0
    dut.s_axil_rready.value = 1
    dut.irq_sources.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _w32(dut, addr, data):
    dut.s_axil_awaddr.value = addr
    dut.s_axil_wdata.value = data
    dut.s_axil_wstrb.value = 0xF
    dut.s_axil_awvalid.value = 1
    dut.s_axil_wvalid.value = 1
    while not (int(dut.s_axil_awready.value) and int(dut.s_axil_wready.value)):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.s_axil_awvalid.value = 0
    dut.s_axil_wvalid.value = 0
    while not int(dut.s_axil_bvalid.value):
        await RisingEdge(dut.clk)
    resp = int(dut.s_axil_bresp.value)
    await RisingEdge(dut.clk)
    return resp


async def _r32(dut, addr):
    dut.s_axil_araddr.value = addr
    dut.s_axil_arvalid.value = 1
    while not int(dut.s_axil_arready.value):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.s_axil_arvalid.value = 0
    while not int(dut.s_axil_rvalid.value):
        await RisingEdge(dut.clk)
    data = int(dut.s_axil_rdata.value)
    resp = int(dut.s_axil_rresp.value)
    await RisingEdge(dut.clk)
    return data, resp


def _irq(dut, ctx: int) -> int:
    return (int(dut.irq_o.value) >> ctx) & 0x1


# Sources are 1-indexed in PLIC. The irq_sources input is packed so that
# irq_sources[s-1] is the line for source s (bit s-1). The enable / pending
# registers, per the PLIC spec, place source s at bit position s (bit 0 is the
# reserved source 0).
def _line_mask(*srcs) -> int:
    """Mask for the irq_sources input (source s at bit s-1)."""
    m = 0
    for s in srcs:
        m |= 1 << (s - 1)
    return m


def _en_mask(*srcs) -> int:
    """Mask for the enable register (source s at bit s, spec convention)."""
    m = 0
    for s in srcs:
        m |= 1 << s
    return m


@cocotb.test()
async def plic_claim_returns_highest_priority(dut):
    """Two sources pending; claim returns the higher-priority one (ctx 0)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # source 2 priority 3, source 3 priority 6.
    await _w32(dut, _prio(2), 3)
    await _w32(dut, _prio(3), 6)
    await _w32(dut, _enable(0), _en_mask(2, 3))
    await _w32(dut, _threshold(0), 0)

    dut.irq_sources.value = _line_mask(2, 3)
    for _ in range(3):
        await RisingEdge(dut.clk)

    assert _irq(dut, 0) == 1, "ctx0 external IRQ should assert"

    claim, _ = await _r32(dut, _claim(0))
    assert claim == 3, f"expected highest-priority claim==3, got {claim}"

    # While source 3 is in service, the next claim must return source 2.
    claim2, _ = await _r32(dut, _claim(0))
    assert claim2 == 2, f"expected next claim==2 (src3 in service), got {claim2}"

    # Complete source 3, then source 2.
    assert await _w32(dut, _claim(0), 3) == 0
    assert await _w32(dut, _claim(0), 2) == 0

    # Drop the lines and confirm the context goes quiet.
    dut.irq_sources.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert _irq(dut, 0) == 0, "ctx0 IRQ should clear after completion + line drop"
    idle, _ = await _r32(dut, _claim(0))
    assert idle == 0, f"claim with nothing pending must return 0, got {idle}"


@cocotb.test()
async def plic_threshold_masks_below(dut):
    """Threshold masks sources whose priority does not strictly exceed it."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # source 1 priority 2, source 2 priority 5.
    await _w32(dut, _prio(1), 2)
    await _w32(dut, _prio(2), 5)
    await _w32(dut, _enable(0), _en_mask(1, 2))
    # threshold 4: only priority > 4 (i.e. source 2) may interrupt.
    await _w32(dut, _threshold(0), 4)

    dut.irq_sources.value = _line_mask(1, 2)
    for _ in range(3):
        await RisingEdge(dut.clk)

    claim, _ = await _r32(dut, _claim(0))
    assert claim == 2, f"threshold 4 should expose only src2, got {claim}"
    assert await _w32(dut, _claim(0), 2) == 0

    # With source 2 completed but line dropped, only source 1 (prio 2 <= 4)
    # remains: it is masked, so claim returns 0 and IRQ is low.
    dut.irq_sources.value = _line_mask(1)
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert _irq(dut, 0) == 0, "low-priority source must be masked by threshold"
    masked, _ = await _r32(dut, _claim(0))
    assert masked == 0, f"masked source must not be claimable, got {masked}"

    # Lower the threshold to 1: source 1 (prio 2) now exceeds it.
    await _w32(dut, _threshold(0), 1)
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert _irq(dut, 0) == 1, "lowering threshold should expose source 1"
    claim1, _ = await _r32(dut, _claim(0))
    assert claim1 == 1, f"expected claim==1 after threshold lowered, got {claim1}"


@cocotb.test()
async def plic_disabled_source_never_fires(dut):
    """A pending source that is not enabled for the context never interrupts."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    await _w32(dut, _prio(4), 7)
    await _w32(dut, _enable(0), _en_mask(1))  # source 4 NOT enabled
    await _w32(dut, _threshold(0), 0)

    dut.irq_sources.value = _line_mask(4)
    for _ in range(3):
        await RisingEdge(dut.clk)

    assert _irq(dut, 0) == 0, "disabled source must not raise IRQ"
    claim, _ = await _r32(dut, _claim(0))
    assert claim == 0, f"disabled source must not be claimable, got {claim}"

    # The gateway still records it pending (visible in the pending block).
    pend, _ = await _r32(dut, PENDING0)
    assert (pend >> 4) & 1 == 1, f"source 4 should be pending in gateway, got {pend:#x}"


@cocotb.test()
async def plic_two_context_isolation(dut):
    """ctx0 and ctx1 have independent enables/thresholds/claims."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    await _w32(dut, _prio(1), 4)
    await _w32(dut, _prio(2), 4)
    # ctx0 sees only source 1; ctx1 sees only source 2.
    await _w32(dut, _enable(0), _en_mask(1))
    await _w32(dut, _enable(1), _en_mask(2))
    await _w32(dut, _threshold(0), 0)
    await _w32(dut, _threshold(1), 0)

    dut.irq_sources.value = _line_mask(1, 2)
    for _ in range(3):
        await RisingEdge(dut.clk)

    assert _irq(dut, 0) == 1 and _irq(dut, 1) == 1, "both contexts should see their source"

    c0, _ = await _r32(dut, _claim(0))
    c1, _ = await _r32(dut, _claim(1))
    assert c0 == 1, f"ctx0 must claim source 1, got {c0}"
    assert c1 == 2, f"ctx1 must claim source 2, got {c1}"

    # Completing ctx0's source must not disturb ctx1's in-service source.
    assert await _w32(dut, _claim(0), 1) == 0
    dut.irq_sources.value = _line_mask(2)  # source 1 line drops
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert _irq(dut, 0) == 0, "ctx0 should be quiet after its source completes"
    # ctx1 source 2 still in service -> not re-pending until completed.
    c1_again, _ = await _r32(dut, _claim(1))
    assert c1_again == 0, f"ctx1 source still in service, claim should be 0, got {c1_again}"
    assert await _w32(dut, _claim(1), 2) == 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    # line still high -> re-pending and claimable again.
    c1_re, _ = await _r32(dut, _claim(1))
    assert c1_re == 2, f"ctx1 source 2 should re-pend after complete, got {c1_re}"
