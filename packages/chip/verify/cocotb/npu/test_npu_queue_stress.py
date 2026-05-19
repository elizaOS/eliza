"""NPU descriptor-queue and IRQ scaffolds.

Targets the v0 NPU microarchitecture documented in
``docs/arch/npu-microarch.md``. Assumes a wrapper module
``e1_npu_gemmini_wrapper`` exposing the documented MMIO map; the wrapper
itself is not yet in the tree (tracked under
``verify/rtl_gap_work_order.yaml#areas.npu``). Until then these tests serve
as the executable spec for the queue/IRQ/unsupported-op contract.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

CTRL = 0x008
STATUS = 0x00C
IRQ_STATUS = 0x010
IRQ_MASK = 0x014
DESC_BASE_LO = 0x018
DESC_RING_LEN = 0x020
DESC_HEAD = 0x024
DESC_TAIL = 0x028
DESC_DOORBELL = 0x02C
PERF_FALLBACKS = 0x04C
ERR_DESC_INDEX = 0x050


async def mmio_write(dut, addr, data):
    dut.s_axil_awaddr.value = addr
    dut.s_axil_awvalid.value = 1
    dut.s_axil_wdata.value = data
    dut.s_axil_wstrb.value = 0xF
    dut.s_axil_wvalid.value = 1
    dut.s_axil_bready.value = 1
    while True:
        await RisingEdge(dut.clk)
        if int(dut.s_axil_bvalid.value):
            break
    dut.s_axil_awvalid.value = 0
    dut.s_axil_wvalid.value = 0
    dut.s_axil_bready.value = 0


async def mmio_read(dut, addr):
    dut.s_axil_araddr.value = addr
    dut.s_axil_arvalid.value = 1
    dut.s_axil_rready.value = 1
    while True:
        await RisingEdge(dut.clk)
        if int(dut.s_axil_rvalid.value):
            value = int(dut.s_axil_rdata.value)
            break
    dut.s_axil_arvalid.value = 0
    dut.s_axil_rready.value = 0
    return value


def make_descriptor(op, m=1, n=1, k=1, a=0x10000, b=0x20000, c=0x30000, flags=0, tag=0):
    """Pack a 64-byte descriptor as 16 little-endian 32-bit words."""
    words = [0] * 16
    words[0] = (op & 0xFFFF) | ((flags & 0xFFFF) << 16)
    words[1] = m
    words[2] = n
    words[3] = k
    words[4] = a & 0xFFFFFFFF
    words[5] = (a >> 32) & 0xFFFFFFFF
    words[6] = b & 0xFFFFFFFF
    words[7] = (b >> 32) & 0xFFFFFFFF
    words[8] = c & 0xFFFFFFFF
    words[9] = (c >> 32) & 0xFFFFFFFF
    words[10] = 16
    words[11] = 16
    words[12] = 16
    words[15] = tag
    return words


async def reset(dut):
    dut.rst_n.value = 0
    for sig in (
        "s_axil_awvalid",
        "s_axil_wvalid",
        "s_axil_arvalid",
        "s_axil_bready",
        "s_axil_rready",
    ):
        if hasattr(dut, sig):
            getattr(dut, sig).value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test(skip=True)
async def test_descriptor_queue_stress(dut):
    """Drive the ring deep enough to exercise wrap and per-descriptor IRQ."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write(dut, DESC_BASE_LO, 0x40000)
    await mmio_write(dut, DESC_RING_LEN, 16)
    await mmio_write(dut, IRQ_MASK, 0x1)
    await mmio_write(dut, CTRL, 0x5)
    head = 0
    for _ in range(4):
        head = (head + 16) & 0xF
        await mmio_write(dut, DESC_DOORBELL, head)
        for _ in range(2000):
            await RisingEdge(dut.clk)
            tail = await mmio_read(dut, DESC_TAIL)
            if tail == head:
                break
        else:
            raise TimeoutError("queue did not drain")


@cocotb.test(skip=True)
async def test_completion_irq(dut):
    """A single MATMUL with irq_on_complete must assert irq_npu."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write(dut, DESC_BASE_LO, 0x40000)
    await mmio_write(dut, DESC_RING_LEN, 4)
    await mmio_write(dut, IRQ_MASK, 0x1)
    await mmio_write(dut, CTRL, 0x5)
    await mmio_write(dut, DESC_DOORBELL, 1)
    saw_irq = False
    for _ in range(20000):
        await RisingEdge(dut.clk)
        if int(dut.irq_npu.value):
            saw_irq = True
            break
    assert saw_irq, "irq_npu never asserted on descriptor completion"
    irq_status = await mmio_read(dut, IRQ_STATUS)
    assert irq_status & 0x1, f"IRQ_STATUS.done not latched: {irq_status:#x}"


@cocotb.test(skip=True)
async def test_unsupported_op_status(dut):
    """An OP outside the v0 set must latch error and unsupported_op."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await mmio_write(dut, DESC_BASE_LO, 0x40000)
    await mmio_write(dut, DESC_RING_LEN, 4)
    await mmio_write(dut, IRQ_MASK, 0x6)
    await mmio_write(dut, CTRL, 0x5)
    await mmio_write(dut, DESC_DOORBELL, 1)
    for _ in range(2000):
        await RisingEdge(dut.clk)
        status = await mmio_read(dut, STATUS)
        if status & 0x10:
            break
    else:
        raise AssertionError("error bit never set for unsupported op")
    irq_status = await mmio_read(dut, IRQ_STATUS)
    assert irq_status & 0x4, "unsupported_op IRQ not latched"
    err_idx = await mmio_read(dut, ERR_DESC_INDEX)
    assert err_idx == 0, f"ERR_DESC_INDEX={err_idx}, expected 0"
    fallbacks = await mmio_read(dut, PERF_FALLBACKS)
    assert fallbacks >= 1, "PERF_FALLBACKS did not increment"
