"""PLIC enable/threshold/claim contract scaffold.

Drives the existing e1_interrupt_controller AXI-Lite target as a
PLIC-style claim/complete contract. The current controller implements
enable + claim + complete but does not yet expose a threshold register;
when the production PLIC lands (see docs/rtl/cpu-config-selection.md)
this test must be extended with threshold writes at offset 0x10.

Register map (matches rtl/interrupts/e1_interrupt_controller.sv):
    0x00  ID                   (RO)
    0x04  PENDING              (RO, set by hardware, cleared by complete)
    0x08  ENABLE               (RW, bit per source)
    0x0C  CLAIM/COMPLETE       (RO=claim_id; W=complete by writing source id)
    0x10  THRESHOLD            (FUTURE; not yet implemented)

The DUT here is e1_linux_soc_contract; the PLIC window is at
CPU-visible base 0x0C00_0000.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PLIC_BASE = 0x0C00_0000
PLIC_PENDING = PLIC_BASE + 0x04
PLIC_ENABLE = PLIC_BASE + 0x08
PLIC_CLAIM = PLIC_BASE + 0x0C
PLIC_THRESHOLD = PLIC_BASE + 0x10  # not yet implemented; future contract


async def _reset(dut):
    dut.rst_n.value = 0
    dut.cpu_awvalid.value = 0
    dut.cpu_wvalid.value = 0
    dut.cpu_bready.value = 1
    dut.cpu_arvalid.value = 0
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


async def _w32(dut, addr, data):
    dut.cpu_awaddr.value = addr
    dut.cpu_wdata.value = data
    dut.cpu_wstrb.value = 0xF
    dut.cpu_awvalid.value = 1
    dut.cpu_wvalid.value = 1
    while not (int(dut.cpu_awready.value) and int(dut.cpu_wready.value)):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.cpu_awvalid.value = 0
    dut.cpu_wvalid.value = 0
    while not int(dut.cpu_bvalid.value):
        await RisingEdge(dut.clk)
    resp = int(dut.cpu_bresp.value)
    await RisingEdge(dut.clk)
    return resp


async def _r32(dut, addr):
    dut.cpu_araddr.value = addr
    dut.cpu_arvalid.value = 1
    while not int(dut.cpu_arready.value):
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.cpu_arvalid.value = 0
    while not int(dut.cpu_rvalid.value):
        await RisingEdge(dut.clk)
    data = int(dut.cpu_rdata.value)
    resp = int(dut.cpu_rresp.value)
    await RisingEdge(dut.clk)
    return data, resp


@cocotb.test()
async def plic_enable_claim_complete_smoke(dut):
    """Enable source 2, pulse it, claim, complete, verify pending clears."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # Enable source id 2 (DMA per docs/arch/interrupts.md).
    assert await _w32(dut, PLIC_ENABLE, 0b0010) == 0

    dut.irq_sources.value = 0b0010
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.irq_sources.value = 0

    assert int(dut.cpu_external_irq.value) == 1

    claim, _ = await _r32(dut, PLIC_CLAIM)
    assert claim == 2, f"expected claim==2, got {claim}"

    assert await _w32(dut, PLIC_CLAIM, 2) == 0

    for _ in range(4):
        await RisingEdge(dut.clk)
    assert int(dut.cpu_external_irq.value) == 0


@cocotb.test(skip=True)
async def plic_threshold_masks_below(dut):
    """FUTURE: threshold register must mask sources at priority <= threshold.

    Skip until the production PLIC wrapper exposes the threshold register
    (see docs/rtl/cpu-config-selection.md step 6).
    """
    pass


@cocotb.test()
async def plic_priority_order_lowest_first_v0(dut):
    """v0 contract: claim returns lowest enabled pending source id.

    e1_interrupt_controller does not yet implement priority; this test
    pins the current behavior so a regression on priority introduction is
    caught and the test is updated deliberately.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)
    assert await _w32(dut, PLIC_ENABLE, 0xF) == 0
    dut.irq_sources.value = 0b1100  # sources 3 and 4
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.irq_sources.value = 0
    claim, _ = await _r32(dut, PLIC_CLAIM)
    assert claim == 3, f"expected lowest-first claim==3, got {claim}"
