import json
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO_ROOT = Path(__file__).resolve().parents[2]
RESP_OKAY = 0
RESP_SLVERR = 2
DRAM_BASE = 0x8000_0000
DRAM_LAST_WORD = 0x8000_0FFC
DRAM_FIRST_OUT_OF_MODEL = 0x8000_1000
INTC_BASE = 0x0C00_0000
DMA_BASE = 0x1001_0000
NPU_BASE = 0x1002_0000
DISPLAY_BASE = 0x1003_0000
DBG_DECODE_ERR_ADDR = 0x1FFF_FFF0
UNMAPPED_READ_VALUE = 0xDEAD_BEEF
MAX_HANDSHAKE_CYCLES = 32
MAX_RESPONSE_CYCLES = 64
_COVERED_CONTRACTS: set[str] = set()


async def start_contract_test(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    cocotb.start_soon(monitor_cpu_valid_ready_stability(dut))
    cocotb.start_soon(monitor_cpu_response_liveness_and_balance(dut))
    await reset(dut)


def signal_value(signal):
    return int(signal.value)


async def monitor_stable_until_ready(dut, channel, valid, ready, payloads):
    while True:
        await RisingEdge(dut.clk)
        if not signal_value(dut.rst_n):
            continue
        if signal_value(valid) and not signal_value(ready):
            values = {name: signal_value(signal) for name, signal in payloads.items()}
            await RisingEdge(dut.clk)
            if not signal_value(dut.rst_n):
                continue
            assert signal_value(valid), f"{channel} valid deasserted before ready"
            for name, expected in values.items():
                actual = signal_value(payloads[name])
                assert actual == expected, f"{channel}.{name} changed while stalled"


async def monitor_cpu_valid_ready_stability(dut):
    cocotb.start_soon(
        monitor_stable_until_ready(
            dut,
            "cpu_aw",
            dut.cpu_awvalid,
            dut.cpu_awready,
            {"addr": dut.cpu_awaddr},
        )
    )
    cocotb.start_soon(
        monitor_stable_until_ready(
            dut,
            "cpu_w",
            dut.cpu_wvalid,
            dut.cpu_wready,
            {"data": dut.cpu_wdata, "strb": dut.cpu_wstrb},
        )
    )
    cocotb.start_soon(
        monitor_stable_until_ready(
            dut,
            "cpu_ar",
            dut.cpu_arvalid,
            dut.cpu_arready,
            {"addr": dut.cpu_araddr},
        )
    )
    cocotb.start_soon(
        monitor_stable_until_ready(
            dut,
            "cpu_b",
            dut.cpu_bvalid,
            dut.cpu_bready,
            {"resp": dut.cpu_bresp},
        )
    )
    cocotb.start_soon(
        monitor_stable_until_ready(
            dut,
            "cpu_r",
            dut.cpu_rvalid,
            dut.cpu_rready,
            {"data": dut.cpu_rdata, "resp": dut.cpu_rresp},
        )
    )


async def monitor_cpu_response_liveness_and_balance(dut):
    write_addr_seen = False
    write_data_seen = False
    write_outstanding = 0
    read_outstanding = 0
    write_age = 0
    read_age = 0

    while True:
        await RisingEdge(dut.clk)
        if not signal_value(dut.rst_n):
            write_addr_seen = False
            write_data_seen = False
            write_outstanding = 0
            read_outstanding = 0
            write_age = 0
            read_age = 0
            continue

        aw_fire = signal_value(dut.cpu_awvalid) and signal_value(dut.cpu_awready)
        w_fire = signal_value(dut.cpu_wvalid) and signal_value(dut.cpu_wready)
        b_fire = signal_value(dut.cpu_bvalid) and signal_value(dut.cpu_bready)
        ar_fire = signal_value(dut.cpu_arvalid) and signal_value(dut.cpu_arready)
        r_fire = signal_value(dut.cpu_rvalid) and signal_value(dut.cpu_rready)

        write_addr_seen = write_addr_seen or aw_fire
        write_data_seen = write_data_seen or w_fire
        if write_addr_seen and write_data_seen:
            write_outstanding += 1
            write_addr_seen = False
            write_data_seen = False

        if ar_fire:
            read_outstanding += 1

        if signal_value(dut.cpu_bvalid):
            assert write_outstanding > 0, "cpu_bvalid asserted with no completed AW/W pair"
        if signal_value(dut.cpu_rvalid):
            assert read_outstanding > 0, "cpu_rvalid asserted with no AR request"

        if b_fire:
            write_outstanding -= 1
            write_age = 0
        elif write_outstanding:
            write_age += 1
            assert write_age <= MAX_RESPONSE_CYCLES, "AXI-Lite write response liveness timeout"

        if r_fire:
            read_outstanding -= 1
            read_age = 0
        elif read_outstanding:
            read_age += 1
            assert read_age <= MAX_RESPONSE_CYCLES, "AXI-Lite read response liveness timeout"


async def wait_for_signal(dut, signal, label, timeout_cycles=MAX_HANDSHAKE_CYCLES):
    for _ in range(timeout_cycles):
        await Timer(1, units="ns")
        if signal_value(signal):
            return
        await RisingEdge(dut.clk)
    raise AssertionError(f"{label} did not assert within {timeout_cycles} cycles")


async def reset(dut):
    dut.rst_n.value = 0
    dut.cpu_awvalid.value = 0
    dut.cpu_awaddr.value = 0
    dut.cpu_wvalid.value = 0
    dut.cpu_wdata.value = 0
    dut.cpu_wstrb.value = 0
    dut.cpu_bready.value = 1
    dut.cpu_arvalid.value = 0
    dut.cpu_araddr.value = 0
    dut.cpu_rready.value = 1
    dut.irq_sources.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def axil_write32(dut, addr, data, strobe=0xF):
    dut.cpu_awaddr.value = addr
    dut.cpu_wdata.value = data
    dut.cpu_wstrb.value = strobe
    dut.cpu_awvalid.value = 1
    dut.cpu_wvalid.value = 1
    dut.cpu_bready.value = 1

    for _ in range(MAX_HANDSHAKE_CYCLES):
        await Timer(1, units="ns")
        if signal_value(dut.cpu_awready) and signal_value(dut.cpu_wready):
            break
        await RisingEdge(dut.clk)
    else:
        raise AssertionError("AXI-Lite write address/data handshake timeout")

    await RisingEdge(dut.clk)
    dut.cpu_awvalid.value = 0
    dut.cpu_wvalid.value = 0

    await wait_for_signal(dut, dut.cpu_bvalid, "AXI-Lite write response", MAX_RESPONSE_CYCLES)
    resp = signal_value(dut.cpu_bresp)

    await RisingEdge(dut.clk)
    return resp


async def axil_split_write32(dut, addr, data, strobe=0xF, data_first=False, gap_cycles=3):
    dut.cpu_bready.value = 1

    if data_first:
        dut.cpu_wdata.value = data
        dut.cpu_wstrb.value = strobe
        dut.cpu_wvalid.value = 1
        for _ in range(MAX_HANDSHAKE_CYCLES):
            await Timer(1, units="ns")
            if signal_value(dut.cpu_wready):
                break
            await RisingEdge(dut.clk)
        else:
            raise AssertionError("AXI-Lite split write data handshake timeout")
        await RisingEdge(dut.clk)
        dut.cpu_wvalid.value = 0

        for _ in range(gap_cycles):
            await RisingEdge(dut.clk)

        dut.cpu_awaddr.value = addr
        dut.cpu_awvalid.value = 1
        for _ in range(MAX_HANDSHAKE_CYCLES):
            await Timer(1, units="ns")
            if signal_value(dut.cpu_awready):
                break
            await RisingEdge(dut.clk)
        else:
            raise AssertionError("AXI-Lite split write address handshake timeout")
        await RisingEdge(dut.clk)
        dut.cpu_awvalid.value = 0
    else:
        dut.cpu_awaddr.value = addr
        dut.cpu_awvalid.value = 1
        for _ in range(MAX_HANDSHAKE_CYCLES):
            await Timer(1, units="ns")
            if signal_value(dut.cpu_awready):
                break
            await RisingEdge(dut.clk)
        else:
            raise AssertionError("AXI-Lite split write address handshake timeout")
        await RisingEdge(dut.clk)
        dut.cpu_awvalid.value = 0

        for _ in range(gap_cycles):
            await RisingEdge(dut.clk)

        dut.cpu_wdata.value = data
        dut.cpu_wstrb.value = strobe
        dut.cpu_wvalid.value = 1
        for _ in range(MAX_HANDSHAKE_CYCLES):
            await Timer(1, units="ns")
            if signal_value(dut.cpu_wready):
                break
            await RisingEdge(dut.clk)
        else:
            raise AssertionError("AXI-Lite split write data handshake timeout")
        await RisingEdge(dut.clk)
        dut.cpu_wvalid.value = 0

    await wait_for_signal(dut, dut.cpu_bvalid, "AXI-Lite split write response", MAX_RESPONSE_CYCLES)
    resp = signal_value(dut.cpu_bresp)

    await RisingEdge(dut.clk)
    return resp


async def axil_read32(dut, addr):
    dut.cpu_araddr.value = addr
    dut.cpu_arvalid.value = 1
    dut.cpu_rready.value = 1

    for _ in range(MAX_HANDSHAKE_CYCLES):
        await Timer(1, units="ns")
        if signal_value(dut.cpu_arready):
            break
        await RisingEdge(dut.clk)
    else:
        raise AssertionError("AXI-Lite read address handshake timeout")

    await RisingEdge(dut.clk)
    dut.cpu_arvalid.value = 0

    await wait_for_signal(dut, dut.cpu_rvalid, "AXI-Lite read response", MAX_RESPONSE_CYCLES)
    data = signal_value(dut.cpu_rdata)
    resp = signal_value(dut.cpu_rresp)

    await RisingEdge(dut.clk)
    return data, resp


def write_coverage_artifact(extra):
    _COVERED_CONTRACTS.update(extra)
    _COVERED_CONTRACTS.update(
        {"axi_lite_valid_ready_stability", "axi_lite_response_liveness_and_balance"}
    )
    coverage = {
        "schema": "e1-chip.cpu_mem_intc_cocotb_coverage.v1",
        "source": "verify/cocotb/test_cpu_mem_intc_contract.py",
        "covered_contracts": sorted(_COVERED_CONTRACTS),
        "boundary": "Directed AXI-Lite memory and interrupt-controller contract checks around the tiny CPU harness only; no application-class CPU, MMU, cache, Linux, or Android boot coverage.",
    }
    out = REPO_ROOT / "build/reports/cpu_mem_intc_cocotb_coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8")


@cocotb.test()
async def axi_lite_split_write_channels_are_captured_independently(dut):
    await start_contract_test(dut)

    assert await axil_split_write32(dut, DRAM_BASE + 0x20, 0xCAFE_BABE) == RESP_OKAY
    data, resp = await axil_read32(dut, DRAM_BASE + 0x20)
    assert resp == RESP_OKAY
    assert data == 0xCAFE_BABE

    assert (
        await axil_split_write32(dut, DRAM_BASE + 0x24, 0x1122_3344, data_first=True) == RESP_OKAY
    )
    data, resp = await axil_read32(dut, DRAM_BASE + 0x24)
    assert resp == RESP_OKAY
    assert data == 0x1122_3344
    write_coverage_artifact({"split_axil_write"})


@cocotb.test()
async def dram_axil_boundary_round_trips(dut):
    await start_contract_test(dut)

    assert await axil_write32(dut, DRAM_BASE + 0x10, 0x1122_3344) == RESP_OKAY
    data, resp = await axil_read32(dut, DRAM_BASE + 0x10)
    assert resp == RESP_OKAY
    assert data == 0x1122_3344

    assert await axil_write32(dut, DRAM_BASE + 0x10, 0xAA00_0000, strobe=0x8) == RESP_OKAY
    data, resp = await axil_read32(dut, DRAM_BASE + 0x10)
    assert resp == RESP_OKAY
    assert data == 0xAA22_3344

    data, resp = await axil_read32(dut, 0x4000_0000)
    assert resp == RESP_SLVERR
    assert data == UNMAPPED_READ_VALUE
    write_coverage_artifact({"dram_strobes", "unmapped_read_slverr"})


@cocotb.test()
async def dram_aperture_outside_sram_model_returns_slverr(dut):
    await start_contract_test(dut)

    assert await axil_write32(dut, DRAM_LAST_WORD, 0x55AA_1234) == RESP_OKAY
    data, resp = await axil_read32(dut, DRAM_LAST_WORD)
    assert resp == RESP_OKAY
    assert data == 0x55AA_1234

    assert await axil_write32(dut, DRAM_FIRST_OUT_OF_MODEL, 0xCAFE_BABE) == RESP_SLVERR
    data, resp = await axil_read32(dut, DRAM_FIRST_OUT_OF_MODEL)
    assert resp == RESP_SLVERR
    assert data == UNMAPPED_READ_VALUE
    write_coverage_artifact({"dram_sram_capacity_boundary"})


@cocotb.test()
async def dram_unaligned_accesses_return_slverr_without_mutating_storage(dut):
    await start_contract_test(dut)

    word_addr = DRAM_BASE + 0x30
    assert await axil_write32(dut, word_addr, 0x1234_5678) == RESP_OKAY

    assert await axil_write32(dut, word_addr + 1, 0xFFFF_0000) == RESP_SLVERR
    data, resp = await axil_read32(dut, word_addr)
    assert resp == RESP_OKAY
    assert data == 0x1234_5678

    data, resp = await axil_read32(dut, word_addr + 2)
    assert resp == RESP_SLVERR
    assert data == UNMAPPED_READ_VALUE
    write_coverage_artifact({"dram_unaligned_slverr_no_mutation"})


@cocotb.test()
async def decode_error_register_captures_last_unmapped_access(dut):
    await start_contract_test(dut)

    data, resp = await axil_read32(dut, 0x4000_0040)
    assert resp == RESP_SLVERR
    assert data == UNMAPPED_READ_VALUE
    data, resp = await axil_read32(dut, DBG_DECODE_ERR_ADDR)
    assert resp == RESP_OKAY
    assert data == 0x4000_0040

    assert await axil_write32(dut, 0x4000_0100, 0xA5A5_5A5A) == RESP_SLVERR
    data, resp = await axil_read32(dut, DBG_DECODE_ERR_ADDR)
    assert resp == RESP_OKAY
    assert data == 0x4000_0100
    write_coverage_artifact({"decode_error_debug_register"})


@cocotb.test()
async def interrupt_controller_claim_complete_contract(dut):
    await start_contract_test(dut)

    data, resp = await axil_read32(dut, 0x0C00_0000)
    assert resp == 0
    assert data == 0x1C00_0001

    assert await axil_write32(dut, 0x0C00_0008, 0b1010) == 0
    dut.irq_sources.value = 0b0010
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)

    data, resp = await axil_read32(dut, 0x0C00_0004)
    assert resp == 0
    assert data & 0b0010
    assert int(dut.cpu_external_irq.value) == 1

    data, resp = await axil_read32(dut, 0x0C00_000C)
    assert resp == 0
    assert data == 2

    dut.irq_sources.value = 0
    assert await axil_write32(dut, 0x0C00_000C, 2) == 0
    await RisingEdge(dut.clk)
    data, resp = await axil_read32(dut, 0x0C00_0004)
    assert resp == 0
    assert data == 0
    assert int(dut.cpu_external_irq.value) == 0


@cocotb.test()
async def interrupt_controller_masks_disabled_sources_but_keeps_pending(dut):
    await start_contract_test(dut)

    dut.irq_sources.value = 0b0101
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    data, resp = await axil_read32(dut, 0x0C00_0004)
    assert resp == 0
    assert data & 0b0101 == 0b0101
    assert int(dut.cpu_external_irq.value) == 0

    assert await axil_write32(dut, 0x0C00_0008, 0b0001) == 0
    assert int(dut.cpu_external_irq.value) == 1
    data, resp = await axil_read32(dut, 0x0C00_000C)
    assert resp == 0
    assert data == 1

    dut.irq_sources.value = 0
    assert await axil_write32(dut, 0x0C00_000C, 1) == 0
    await RisingEdge(dut.clk)
    assert int(dut.cpu_external_irq.value) == 0
    data, resp = await axil_read32(dut, 0x0C00_0004)
    assert resp == 0
    assert data & 0b0100 == 0b0100

    assert await axil_write32(dut, 0x0C00_0008, 0b0100) == 0
    data, resp = await axil_read32(dut, 0x0C00_000C)
    assert resp == 0
    assert data == 3

    write_coverage_artifact(
        {"split_axil_write", "dram_strobes", "interrupt_mask_pending_claim_complete"}
    )


async def wait_dma_done(dut, timeout_cycles=100):
    for cycle in range(timeout_cycles):
        data, resp = await axil_read32(dut, 0x1001_000C)
        assert resp == 0
        if data & 0x2:
            return cycle + 1, data
    raise AssertionError("DMA did not complete")


async def wait_npu_done(dut, timeout_cycles=20):
    for _ in range(timeout_cycles):
        data, resp = await axil_read32(dut, NPU_BASE + 0x0C)
        assert resp == RESP_OKAY
        if data & 0x2:
            return data
    raise AssertionError("NPU did not complete")


@cocotb.test()
async def dma_bus_master_copies_dram_and_reports_counters(dut):
    await start_contract_test(dut)

    assert await axil_write32(dut, 0x8000_0040, 0x1122_3344) == 0
    assert await axil_write32(dut, 0x8000_0044, 0x5566_7788) == 0

    assert await axil_write32(dut, 0x1001_0000, 0x8000_0040) == 0
    assert await axil_write32(dut, 0x1001_0004, 0x8000_0080) == 0
    assert await axil_write32(dut, 0x1001_0008, 8) == 0
    assert await axil_write32(dut, 0x1001_000C, 1) == 0

    cycles, status = await wait_dma_done(dut)
    assert status & 0x1 == 0
    assert status & 0x4 == 0
    assert 4 <= cycles <= 40

    data, resp = await axil_read32(dut, 0x8000_0080)
    assert resp == 0
    assert data == 0x1122_3344
    data, resp = await axil_read32(dut, 0x8000_0084)
    assert resp == 0
    assert data == 0x5566_7788

    data, resp = await axil_read32(dut, 0x1001_0014)
    assert resp == 0
    assert data == 8
    data, resp = await axil_read32(dut, 0x1001_0018)
    assert resp == 0
    assert data == 2
    data, resp = await axil_read32(dut, 0x1001_0030)
    assert resp == 0
    assert data == 2
    data, resp = await axil_read32(dut, 0x1001_0034)
    assert resp == 0
    assert data == 2


@cocotb.test()
async def dma_non_dram_targets_fault_without_mmio_side_effects(dut):
    await start_contract_test(dut)

    assert await axil_write32(dut, 0x1001_0000, 0x8000_0041) == 0
    assert await axil_write32(dut, 0x1001_0004, 0x8000_0080) == 0
    assert await axil_write32(dut, 0x1001_0008, 4) == 0
    assert await axil_write32(dut, 0x1001_000C, 1) == 0
    data, resp = await axil_read32(dut, 0x1001_000C)
    assert resp == 0
    assert data & 0x6 == 0x6

    assert await axil_write32(dut, 0x1001_000C, 2) == 0
    assert await axil_write32(dut, 0x1001_0000, 0x9000_0000) == 0
    assert await axil_write32(dut, 0x1001_0004, 0x8000_0080) == 0
    assert await axil_write32(dut, 0x1001_0008, 4) == 0
    assert await axil_write32(dut, 0x1001_000C, 1) == 0
    _, status = await wait_dma_done(dut)
    assert status & 0x6 == 0x6
    data, resp = await axil_read32(dut, 0x1001_0038)
    assert resp == 0
    assert data == 1
    mask, resp = await axil_read32(dut, 0x0C00_0008)
    assert resp == 0
    assert mask == 0

    assert await axil_write32(dut, NPU_BASE + 0x00, 0xAA55_0001) == RESP_OKAY
    assert await axil_write32(dut, DISPLAY_BASE + 0x00, DRAM_BASE + 0x180) == RESP_OKAY
    assert await axil_write32(dut, DRAM_BASE + 0xA0, 0xFFFF_0000) == RESP_OKAY

    assert await axil_write32(dut, DMA_BASE + 0x0C, 2) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x00, DRAM_BASE + 0xA0) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x04, NPU_BASE + 0x00) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x08, 4) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x0C, 1) == RESP_OKAY
    _, status = await wait_dma_done(dut)
    assert status & 0x6 == 0x6
    data, resp = await axil_read32(dut, NPU_BASE + 0x00)
    assert resp == RESP_OKAY
    assert data == 0xAA55_0001

    assert await axil_write32(dut, DMA_BASE + 0x0C, 2) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x00, DRAM_BASE + 0xA0) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x04, DISPLAY_BASE + 0x00) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x08, 4) == RESP_OKAY
    assert await axil_write32(dut, DMA_BASE + 0x0C, 1) == RESP_OKAY
    _, status = await wait_dma_done(dut)
    assert status & 0x6 == 0x6
    data, resp = await axil_read32(dut, DISPLAY_BASE + 0x00)
    assert resp == RESP_OKAY
    assert data == DRAM_BASE + 0x180
    write_coverage_artifact({"dma_npu_display_mmio_no_side_effect"})


@cocotb.test()
async def linux_contract_exposes_npu_and_display_mmio_targets(dut):
    await start_contract_test(dut)

    assert await axil_write32(dut, NPU_BASE + 0x00, 0x11) == RESP_OKAY
    assert await axil_write32(dut, NPU_BASE + 0x04, 0x22) == RESP_OKAY
    assert await axil_write32(dut, NPU_BASE + 0x10, 0x0) == RESP_OKAY
    assert await axil_write32(dut, NPU_BASE + 0x0C, 0x1) == RESP_OKAY
    status = await wait_npu_done(dut)
    assert status & 0x4 == 0
    data, resp = await axil_read32(dut, NPU_BASE + 0x08)
    assert resp == RESP_OKAY
    assert data == 0x33

    assert await axil_write32(dut, DISPLAY_BASE + 0x00, DRAM_BASE + 0x100) == RESP_OKAY
    assert await axil_write32(dut, DISPLAY_BASE + 0x04, (2 << 16) | 3) == RESP_OKAY
    fb_base, resp = await axil_read32(dut, DISPLAY_BASE + 0x00)
    assert resp == RESP_OKAY
    assert fb_base == DRAM_BASE + 0x100
    geometry, resp = await axil_read32(dut, DISPLAY_BASE + 0x04)
    assert resp == RESP_OKAY
    assert geometry == ((2 << 16) | 3)

    data, resp = await axil_read32(dut, DISPLAY_BASE + 0x1000)
    assert resp == RESP_SLVERR
    assert data == UNMAPPED_READ_VALUE
    write_coverage_artifact({"linux_contract_npu_mmio", "linux_contract_display_mmio"})
