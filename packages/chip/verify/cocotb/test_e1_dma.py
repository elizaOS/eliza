import json
import random
import sys
from datetime import UTC, datetime
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_reg, reset, word_read, word_write, write_reg  # noqa: E402
from coverage_helpers import CoverPointSet, axi_resp_name  # noqa: E402

AXI_RESP_BINS = ("OKAY", "SLVERR", "DECERR")
DMA_IRQ_BINS = ("done", "error", "idle")
_DMA_COVER = CoverPointSet("dma")
_DMA_COVER.declare("axi_resp", "bresp", AXI_RESP_BINS)
_DMA_COVER.declare("axi_resp", "rresp", AXI_RESP_BINS)
_DMA_COVER.declare("irq_vector", "dma_irq", DMA_IRQ_BINS)


async def randomized_axil_memory(dut, mem, rng, error_addresses=frozenset()):
    pending_read = None
    pending_write_resp = None
    pending_aw = None
    pending_w = None
    while True:
        dut.m_axil_arready.value = rng.randrange(4) != 0
        dut.m_axil_awready.value = pending_aw is None and rng.randrange(4) != 0
        dut.m_axil_wready.value = pending_w is None and rng.randrange(4) != 0

        await Timer(1, units="ns")
        ar_fire = int(dut.m_axil_arvalid.value) and int(dut.m_axil_arready.value)
        aw_fire = int(dut.m_axil_awvalid.value) and int(dut.m_axil_awready.value)
        w_fire = int(dut.m_axil_wvalid.value) and int(dut.m_axil_wready.value)

        if ar_fire:
            addr = int(dut.m_axil_araddr.value)
            resp = 2 if addr in error_addresses else 0
            pending_read = (word_read(mem, addr), resp)
            _DMA_COVER.sample("axi_resp", "rresp", axi_resp_name(resp))

        if aw_fire:
            pending_aw = int(dut.m_axil_awaddr.value)
        if w_fire:
            pending_w = (int(dut.m_axil_wdata.value), int(dut.m_axil_wstrb.value))

        if pending_aw is not None and pending_w is not None and pending_write_resp is None:
            addr = pending_aw
            data, strobe = pending_w
            resp = 2 if addr in error_addresses else 0
            if resp == 0:
                word_write(mem, addr, data, strobe)
            pending_write_resp = resp
            _DMA_COVER.sample("axi_resp", "bresp", axi_resp_name(resp))
            pending_aw = None
            pending_w = None

        await RisingEdge(dut.clk)

        if int(dut.m_axil_rvalid.value) and int(dut.m_axil_rready.value):
            dut.m_axil_rvalid.value = 0
        if int(dut.m_axil_bvalid.value) and int(dut.m_axil_bready.value):
            dut.m_axil_bvalid.value = 0

        if pending_read is not None and not int(dut.m_axil_rvalid.value):
            data, resp = pending_read
            dut.m_axil_rdata.value = data
            dut.m_axil_rresp.value = resp
            dut.m_axil_rvalid.value = 1
            pending_read = None

        if pending_write_resp is not None and not int(dut.m_axil_bvalid.value):
            dut.m_axil_bresp.value = pending_write_resp
            dut.m_axil_bvalid.value = 1
            pending_write_resp = None


async def start_dma(dut, src, dst, length):
    await write_reg(dut, 0x00, src)
    await write_reg(dut, 0x01, dst)
    await write_reg(dut, 0x02, length)
    await write_reg(dut, 0x03, 1)


async def wait_done(dut, timeout_cycles=300):
    for _ in range(timeout_cycles):
        status = await read_reg(dut, 0x03)
        if status & 0x2:
            return status
    raise AssertionError("DMA did not complete")


def write_coverage_artifact(extra):
    covered = {
        "randomized_backpressure",
        "byte_exact_copy",
        "done_irq_clear",
        "zero_length_no_bus",
        "partial_tail_wstrb",
        "bus_response_error",
    } | set(extra)
    coverage = {
        "schema": "e1-chip.dma_cocotb_coverage.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": "directed_dma_cocotb_coverage_only_not_system_or_release_evidence",
        "source": "verify/cocotb/test_e1_dma.py",
        "covered_contracts": sorted(covered),
        "status_bits": ["busy", "done", "error"],
        "boundary": "Directed e1_dma byte-copy, strobe, interrupt, and AXI-Lite response checks only; no coherent DMA, IOMMU, cache, or OS driver coverage.",
    }
    out = REPO_ROOT / "build/reports/dma_cocotb_coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _DMA_COVER.write_json(extra={"covered_contracts": sorted(covered)})


@cocotb.test()
async def dma_randomized_backpressure_copies_bytes(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0xD00D_2026)
    await reset(dut)

    for case in range(12):
        mem = {}
        src = 0x8000_0000 + case * 0x80
        dst = 0x8000_0800 + case * 0x80
        length = rng.randrange(1, 49)
        for offset in range(length + 8):
            mem[src + offset] = rng.randrange(256)
        expected = bytes(mem.get(src + offset, 0) for offset in range(length))

        mem_task = cocotb.start_soon(randomized_axil_memory(dut, mem, rng))
        await start_dma(dut, src, dst, length)
        status = await wait_done(dut)
        mem_task.kill()

        assert status == 0x2
        assert int(dut.irq.value) == 1
        _DMA_COVER.sample("irq_vector", "dma_irq", "done")
        assert await read_reg(dut, 0x05) == length
        assert await read_reg(dut, 0x0C) == (length + 3) // 4
        assert await read_reg(dut, 0x0D) == (length + 3) // 4
        observed = bytes(mem.get(dst + offset, 0) for offset in range(length))
        assert observed == expected
        await write_reg(dut, 0x03, 2)
        assert int(dut.irq.value) == 0
        _DMA_COVER.sample("irq_vector", "dma_irq", "idle")

    write_coverage_artifact({"randomized_backpressure", "byte_exact_copy", "done_irq_clear"})


@cocotb.test()
async def dma_zero_length_and_partial_tail_have_no_extra_writes(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0x510B_EA7)
    await reset(dut)

    mem = {
        0x8000_0000 + offset: value
        for offset, value in enumerate([0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55])
    }
    for offset, value in enumerate([0xAA, 0xAA, 0xAA, 0xAA, 0xCC, 0xCC, 0xCC, 0xCC]):
        mem[0x8000_0100 + offset] = value

    mem_task = cocotb.start_soon(randomized_axil_memory(dut, mem, rng))
    await start_dma(dut, 0x8000_0000, 0x8000_0100, 0)
    assert await wait_done(dut) == 0x2
    assert await read_reg(dut, 0x05) == 0
    assert await read_reg(dut, 0x0C) == 0
    assert await read_reg(dut, 0x0D) == 0
    assert word_read(mem, 0x8000_0100) == 0xAAAA_AAAA
    await write_reg(dut, 0x03, 2)

    await start_dma(dut, 0x8000_0000, 0x8000_0100, 6)
    assert await wait_done(dut) == 0x2
    mem_task.kill()

    assert await read_reg(dut, 0x05) == 6
    assert await read_reg(dut, 0x06) == 2
    assert await read_reg(dut, 0x0C) == 2
    assert await read_reg(dut, 0x0D) == 2
    trace = await read_reg(dut, 0x0B)
    assert ((trace >> 7) & 0xF) == 0x3
    assert word_read(mem, 0x8000_0100) == 0x1122_3344
    assert word_read(mem, 0x8000_0104) == 0xCCCC_7788

    write_coverage_artifact({"zero_length_no_bus", "partial_tail_wstrb", "byte_exact_copy"})


@cocotb.test()
async def dma_bus_response_errors_are_fail_closed(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0xBAD_EA55)
    await reset(dut)

    mem = {0x8000_0000 + offset: offset & 0xFF for offset in range(16)}
    mem_task = cocotb.start_soon(
        randomized_axil_memory(dut, mem, rng, error_addresses={0x8000_0000, 0x8000_0100})
    )
    await start_dma(dut, 0x8000_0000, 0x8000_0100, 8)
    status = await wait_done(dut)
    mem_task.kill()

    assert status & 0x6 == 0x6
    _DMA_COVER.sample("irq_vector", "dma_irq", "error")
    assert await read_reg(dut, 0x0E) == 1
    assert await read_reg(dut, 0x05) == 0
    write_coverage_artifact({"bus_response_error"})
