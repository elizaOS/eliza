"""Decode-error response on unmapped MMIO.

e1_axi_lite_interconnect (under e1_linux_soc_contract) decodes three
windows:
    0x8000_0000.. DRAM  (top nibble 0x8)
    0x0C00_0000.. INTC  (top 20 bits == 0x0C000)
    0x1001_0000.. DMA   (top 20 bits == 0x10010)

Any other address must produce a DECERR (bresp/rresp = 2'b11). This test
sweeps a handful of unmapped addresses for both reads and writes and pins
the fail-closed behavior. It also asserts that a DECERR does not wedge
subsequent traffic.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

UNMAPPED_ADDRESSES = [
    0x0000_0000,  # below all windows
    0x0000_1000,  # boot ROM aperture (not exposed on this fabric)
    0x0200_0000,  # future CLINT window, currently unmapped
    0x0C00_1000,  # one page past INTC, still in nibble 0x0C
    0x1001_1000,  # one page past DMA
    0x1FFF_FFFC,  # below DRAM, above DMA
    0x7FFF_FFFC,  # just below DRAM base
    0xC000_0000,  # above DRAM nibble
    0xFFFF_FFFC,  # top of memory
]


async def _reset(dut):
    dut.rst_n.value = 0
    dut.cpu_awvalid.value = 0
    dut.cpu_wvalid.value = 0
    dut.cpu_arvalid.value = 0
    dut.cpu_bready.value = 1
    dut.cpu_rready.value = 1
    dut.cpu_awaddr.value = 0
    dut.cpu_wdata.value = 0
    dut.cpu_wstrb.value = 0
    dut.cpu_araddr.value = 0
    dut.irq_sources.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _wr(dut, addr):
    dut.cpu_awaddr.value = addr
    dut.cpu_wdata.value = 0xDEAD_BEEF
    dut.cpu_wstrb.value = 0xF
    dut.cpu_awvalid.value = 1
    dut.cpu_wvalid.value = 1
    cycles = 0
    while not (int(dut.cpu_awready.value) and int(dut.cpu_wready.value)):
        await RisingEdge(dut.clk)
        cycles += 1
        assert cycles < 64, f"awready/wready never asserted for {addr:#x}"
    await RisingEdge(dut.clk)
    dut.cpu_awvalid.value = 0
    dut.cpu_wvalid.value = 0
    cycles = 0
    while not int(dut.cpu_bvalid.value):
        await RisingEdge(dut.clk)
        cycles += 1
        assert cycles < 64, f"bvalid never asserted for {addr:#x}"
    resp = int(dut.cpu_bresp.value)
    await RisingEdge(dut.clk)
    return resp


async def _rd(dut, addr):
    dut.cpu_araddr.value = addr
    dut.cpu_arvalid.value = 1
    cycles = 0
    while not int(dut.cpu_arready.value):
        await RisingEdge(dut.clk)
        cycles += 1
        assert cycles < 64, f"arready never asserted for {addr:#x}"
    await RisingEdge(dut.clk)
    dut.cpu_arvalid.value = 0
    cycles = 0
    while not int(dut.cpu_rvalid.value):
        await RisingEdge(dut.clk)
        cycles += 1
        assert cycles < 64, f"rvalid never asserted for {addr:#x}"
    resp = int(dut.cpu_rresp.value)
    await RisingEdge(dut.clk)
    return resp


@cocotb.test()
async def unmapped_writes_return_decerr(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)
    for addr in UNMAPPED_ADDRESSES:
        resp = await _wr(dut, addr)
        assert resp == 0b11, (
            f"expected DECERR (0b11) for unmapped write at {addr:#x}, got {resp:#b}"
        )


@cocotb.test()
async def unmapped_reads_return_decerr(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)
    for addr in UNMAPPED_ADDRESSES:
        resp = await _rd(dut, addr)
        assert resp == 0b11, f"expected DECERR (0b11) for unmapped read at {addr:#x}, got {resp:#b}"


@cocotb.test()
async def decode_error_does_not_wedge_subsequent_traffic(dut):
    """After a DECERR, a valid INTC read still completes with OKAY."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)
    assert await _wr(dut, 0xDEAD_0000) == 0b11
    # INTC ID register at 0x0C00_0000 must respond OKAY.
    resp = await _rd(dut, 0x0C00_0000)
    assert resp == 0b00, f"INTC read after DECERR should be OKAY, got {resp:#b}"
