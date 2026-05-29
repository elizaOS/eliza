"""Long-transfer cocotb coverage for e1_dma.

Directed tests targeting the DMA RTL ports declared in ``rtl/dma/e1_dma.sv``,
following the handshake style of ``verify/cocotb/test_e1_dma.py``. This suite
is run by the top-level ``cocotb-dma`` gate.
"""

import random
import sys
import json
from datetime import UTC, datetime
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_reg, write_reg  # noqa: E402
from common import reset as _reset  # noqa: E402
from common import word_read, word_write  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
SRC_REG = 0x00
DST_REG = 0x01
LEN_REG = 0x02
CTRL_REG = 0x03
STATUS_REG = 0x03
BYTES_DONE_REG = 0x05
_COVERED_CONTRACTS: set[str] = set()


def write_coverage_artifact(extra):
    _COVERED_CONTRACTS.update(extra)
    coverage = {
        "schema": "e1-chip.dma_long_transfer_cocotb_coverage.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": "directed_dma_long_transfer_cocotb_coverage_only_not_system_or_release_evidence",
        "source": "verify/cocotb/dma/test_dma_long_transfer.py",
        "covered_contracts": sorted(_COVERED_CONTRACTS),
        "boundary": "Directed standalone e1_dma long-transfer, partial-tail, IRQ, unaligned-programming, and SLVERR propagation coverage only; no coherent DMA, IOMMU, cache, or production memory hierarchy coverage.",
    }
    out = REPO_ROOT / "build/reports/dma_long_transfer_cocotb_coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8")


async def reset(dut):
    # DMA long-transfer models an always-ready slave, so hold the AXI-Lite
    # ready lines high through reset (axil_ready=1).
    await _reset(dut, axil_ready=1)


async def axil_memory(dut, mem, rng, error_addrs=frozenset()):
    """Lightweight AXI-Lite slave: services reads/writes with randomized
    ready/valid and optional SLVERR injection."""
    pending_rd_resp = None
    pending_aw = None
    pending_w = None
    pending_b = None
    while True:
        dut.m_axil_arready.value = pending_rd_resp is None and rng.randrange(3) != 0
        dut.m_axil_awready.value = pending_aw is None and rng.randrange(3) != 0
        dut.m_axil_wready.value = pending_w is None and rng.randrange(3) != 0
        if pending_rd_resp is not None:
            data, resp = pending_rd_resp
            dut.m_axil_rdata.value = data
            dut.m_axil_rresp.value = resp
            dut.m_axil_rvalid.value = 1
        else:
            dut.m_axil_rvalid.value = 0
        if pending_b is not None:
            dut.m_axil_bvalid.value = 1
            dut.m_axil_bresp.value = pending_b
        else:
            dut.m_axil_bvalid.value = 0

        await RisingEdge(dut.clk)
        if pending_rd_resp is not None and int(dut.m_axil_rready.value):
            pending_rd_resp = None
        if pending_b is not None and int(dut.m_axil_bready.value):
            pending_b = None
        if int(dut.m_axil_arvalid.value) and int(dut.m_axil_arready.value):
            addr = int(dut.m_axil_araddr.value)
            pending_rd_resp = (word_read(mem, addr), 2 if addr in error_addrs else 0)
        if int(dut.m_axil_awvalid.value) and int(dut.m_axil_awready.value):
            pending_aw = int(dut.m_axil_awaddr.value)
        if int(dut.m_axil_wvalid.value) and int(dut.m_axil_wready.value):
            pending_w = (int(dut.m_axil_wdata.value), int(dut.m_axil_wstrb.value))
        if pending_aw is not None and pending_w is not None and pending_b is None:
            data, strb = pending_w
            if pending_aw not in error_addrs:
                word_write(mem, pending_aw, data, strb)
            pending_b = 2 if pending_aw in error_addrs else 0
            pending_aw = None
            pending_w = None


async def wait_done(dut, timeout=20000):
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        status = await read_reg(dut, STATUS_REG)
        if status & 0x2:
            return status
    raise TimeoutError("DMA did not signal done")


@cocotb.test()
async def test_long_transfer_1kib(dut):
    """256 words (1 KiB) must report 1024 bytes_done with correct payload."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(0xDEADBEEF)
    mem = {0x1000 + i: rng.randrange(256) for i in range(1024)}
    cocotb.start_soon(axil_memory(dut, mem, rng))
    await write_reg(dut, SRC_REG, 0x1000)
    await write_reg(dut, DST_REG, 0x4000)
    await write_reg(dut, LEN_REG, 1024)
    await write_reg(dut, CTRL_REG, 0x1)
    await wait_done(dut)
    bytes_done = await read_reg(dut, BYTES_DONE_REG)
    assert bytes_done == 1024, f"expected 1024, got {bytes_done}"
    for i in range(1024):
        assert mem.get(0x4000 + i, 0) == mem[0x1000 + i], f"mismatch +{i}"
    write_coverage_artifact({"long_transfer_1kib", "bytes_done_accounting"})


@cocotb.test()
async def test_byte_strobes_partial_tail(dut):
    """A non-multiple-of-4 length must use a narrower wstrb on the last beat."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(1)
    mem = {0x1000 + i: 0xA0 + i for i in range(7)}
    cocotb.start_soon(axil_memory(dut, mem, rng))
    await write_reg(dut, SRC_REG, 0x1000)
    await write_reg(dut, DST_REG, 0x4000)
    await write_reg(dut, LEN_REG, 7)
    await write_reg(dut, CTRL_REG, 0x1)
    await wait_done(dut)
    for i in range(7):
        assert mem.get(0x4000 + i, 0) == mem[0x1000 + i]
    assert 0x4007 not in mem or mem[0x4007] == 0
    write_coverage_artifact({"partial_tail_wstrb"})


@cocotb.test()
async def test_unaligned_programming_sets_error(dut):
    """Unaligned src/dst must surface as an error without bus traffic."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(2)
    cocotb.start_soon(axil_memory(dut, {}, rng))
    await write_reg(dut, SRC_REG, 0x1001)
    await write_reg(dut, DST_REG, 0x4000)
    await write_reg(dut, LEN_REG, 16)
    await write_reg(dut, CTRL_REG, 0x1)
    for _ in range(20):
        await RisingEdge(dut.clk)
    status = await read_reg(dut, STATUS_REG)
    assert status & 0x4, f"error bit not set, status={status:#x}"
    write_coverage_artifact({"unaligned_programming_error"})


@cocotb.test()
async def test_completion_irq_pulses(dut):
    """irq must assert when the transfer completes."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(3)
    mem = {0x1000 + i: i & 0xFF for i in range(64)}
    cocotb.start_soon(axil_memory(dut, mem, rng))
    await write_reg(dut, SRC_REG, 0x1000)
    await write_reg(dut, DST_REG, 0x4000)
    await write_reg(dut, LEN_REG, 64)
    await write_reg(dut, CTRL_REG, 0x1)
    saw_irq = False
    for _ in range(4000):
        await RisingEdge(dut.clk)
        if int(dut.irq.value):
            saw_irq = True
            break
    assert saw_irq, "DMA completion IRQ never asserted"
    write_coverage_artifact({"completion_irq"})


@cocotb.test()
async def test_bus_error_propagates(dut):
    """A SLVERR on a read response must latch the DMA error counter."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    rng = random.Random(4)
    mem = {0x1000 + i: i & 0xFF for i in range(64)}
    cocotb.start_soon(axil_memory(dut, mem, rng, error_addrs={0x1010}))
    await write_reg(dut, SRC_REG, 0x1000)
    await write_reg(dut, DST_REG, 0x4000)
    await write_reg(dut, LEN_REG, 64)
    await write_reg(dut, CTRL_REG, 0x1)
    for _ in range(5000):
        await RisingEdge(dut.clk)
        status = await read_reg(dut, STATUS_REG)
        if status & 0x4:
            write_coverage_artifact({"read_slverr_propagates"})
            return
    raise AssertionError("bus error did not propagate to DMA status")
