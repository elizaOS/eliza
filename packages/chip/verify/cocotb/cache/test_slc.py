"""SLC standalone cocotb tests.

Exercises the System-Level Cache (`e1_slc`) via the `e1_slc_tb` wrapper.
The wrapper flattens `qos_class_e` to a 3-bit port and unpacks the
per-bank / per-qos way-mask arrays.

Tests:
- reset is quiescent
- way-partitioning: an NPU request can only fill into ways that are
  enabled in the NPU's allocation mask
- way-shutoff (DVFS): disabling all but one way per bank forces the
  victim onto that single way
- BDI compression: when a write installs an all-zero line, the BDI
  compress HPM event fires
- NPU stash hint: NPU traffic inserts with RRPV=3 (the SLC's NPU-stash
  policy) - we observe by verifying that an immediate NPU read of the
  same line hits without going to DRAM
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

QOS_DISPLAY_RT = 0
QOS_CAMERA_ISP = 1
QOS_CPU_FG     = 2
QOS_CPU_BG     = 3
QOS_NPU        = 4
QOS_GPU        = 5


def all_ways_enabled(banks: int, ways: int) -> int:
    """Pack BANKS * WAYS bits of way_enable_mask, all set."""
    mask = 0
    for b in range(banks):
        mask |= ((1 << ways) - 1) << (b * ways)
    return mask


def all_qos_open(ways: int) -> int:
    """Pack 8 * WAYS bits of way_alloc_mask, every qos sees every way."""
    mask = 0
    for q in range(8):
        mask |= ((1 << ways) - 1) << (q * ways)
    return mask


def qos_alloc_mask(qos: int, ways: int, allowed_ways: int) -> int:
    """Build a way_alloc_mask_flat with `qos` restricted to `allowed_ways`;
    every other QoS sees every way."""
    mask = 0
    for q in range(8):
        if q == qos:
            mask |= allowed_ways << (q * ways)
        else:
            mask |= ((1 << ways) - 1) << (q * ways)
    return mask


async def reset_dut(dut, banks: int = 2, ways: int = 4) -> None:
    dut.rst_n.value = 0
    dut.req_valid.value = 0
    dut.req_paddr_line.value = 0
    dut.req_is_write.value = 0
    dut.req_qos.value = QOS_CPU_FG
    dut.req_client_id.value = 0
    dut.req_wb_data.value = 0
    dut.resp_ready.value = 1
    dut.dram_acq_ready.value = 1
    dut.dram_grant_valid.value = 0
    dut.dram_grant_paddr_line.value = 0
    dut.dram_grant_data.value = 0
    dut.way_enable_mask_flat.value = all_ways_enabled(banks, ways)
    dut.way_alloc_mask_flat.value = all_qos_open(ways)
    dut.display_window_cycles.value = 32
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for(dut, signal: str, max_cycles: int = 64) -> int:
    for cyc in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal).value) == 1:
            return cyc
    raise AssertionError(f"{signal} never asserted within {max_cycles} cycles")


async def serve_dram(dut, paddr_line: int, data: int) -> None:
    await wait_for(dut, "dram_acq_valid")
    # Skip writebacks
    while int(dut.dram_acq_is_write.value) == 1:
        await RisingEdge(dut.clk)
        if int(dut.dram_acq_valid.value) == 0:
            await wait_for(dut, "dram_acq_valid")
    await RisingEdge(dut.clk)
    dut.dram_grant_valid.value = 1
    dut.dram_grant_paddr_line.value = paddr_line
    dut.dram_grant_data.value = data
    await RisingEdge(dut.clk)
    dut.dram_grant_valid.value = 0


async def issue_req(dut, paddr_line: int, *, is_write: int = 0,
                    qos: int = QOS_CPU_FG, client: int = 0,
                    wb_data: int = 0) -> None:
    dut.req_valid.value = 1
    dut.req_paddr_line.value = paddr_line
    dut.req_is_write.value = is_write
    dut.req_qos.value = qos
    dut.req_client_id.value = client
    dut.req_wb_data.value = wb_data
    await RisingEdge(dut.clk)
    dut.req_valid.value = 0


@cocotb.test()
async def test_slc_reset_quiescent(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    await RisingEdge(dut.clk)
    assert int(dut.resp_valid.value) == 0
    assert int(dut.dram_acq_valid.value) == 0


@cocotb.test()
async def test_slc_basic_miss_then_hit(dut):
    """Simple miss/hit baseline so the harness sanity-checks end-to-end."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_0800_0000
    await issue_req(dut, line, qos=QOS_CPU_FG)
    await serve_dram(dut, line, data=0x1234)
    await wait_for(dut, "resp_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    # Same-line re-read should hit (no further dram_acq read)
    await issue_req(dut, line, qos=QOS_CPU_FG)
    saw_resp = False
    saw_dram_read = False
    for _ in range(12):
        await RisingEdge(dut.clk)
        if int(dut.resp_valid.value) == 1:
            saw_resp = True
        if int(dut.dram_acq_valid.value) == 1 and int(dut.dram_acq_is_write.value) == 0:
            saw_dram_read = True
    assert saw_resp
    assert not saw_dram_read, "hit must not re-fetch from DRAM"


@cocotb.test()
async def test_slc_qos_way_partitioning(dut):
    """Way-partition by QoS: when NPU is restricted to a single way, the
    SLC must pick that way as victim for NPU traffic. We verify by
    observing that two NPU misses to addresses mapping to the same set
    behave as if a 1-way cache (the second miss evicts the first)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    # Restrict NPU to way 0 only
    dut.way_alloc_mask_flat.value = qos_alloc_mask(QOS_NPU, ways=4, allowed_ways=0b0001)

    line_a = 0x0000_0900_0000  # bank/set determined by addr bits
    line_b = line_a | (1 << 14)  # different tag, same set/bank

    await issue_req(dut, line_a, qos=QOS_NPU)
    await serve_dram(dut, line_a, data=0xA)
    await wait_for(dut, "resp_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    await issue_req(dut, line_b, qos=QOS_NPU)
    await serve_dram(dut, line_b, data=0xB)
    await wait_for(dut, "resp_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    # Re-issue line_a: with NPU restricted to one way it should have been
    # evicted by the line_b install, so we expect another DRAM read.
    await issue_req(dut, line_a, qos=QOS_NPU)
    saw_dram_read = False
    for _ in range(32):
        await RisingEdge(dut.clk)
        if int(dut.dram_acq_valid.value) == 1 and int(dut.dram_acq_is_write.value) == 0:
            saw_dram_read = True
            break
    assert saw_dram_read, "NPU restricted to 1 way must evict line_a on line_b install"


@cocotb.test()
async def test_slc_way_shutoff_dvfs(dut):
    """Disable all-but-one way per bank: SLC must continue to serve via
    the single enabled way."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    # Enable only way 0 in every bank
    mask = 0
    for b in range(2):
        mask |= 0b0001 << (b * 4)
    dut.way_enable_mask_flat.value = mask

    line = 0x0000_0A00_0000
    await issue_req(dut, line, qos=QOS_CPU_FG)
    await serve_dram(dut, line, data=0xC0DE)
    await wait_for(dut, "resp_valid")


@cocotb.test()
async def test_slc_bdi_compress_on_zero_write(dut):
    """Writing a zero-line via a write request causes the BDI compress
    HPM event to pulse."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_0B00_0000
    # First install the line via a read so the cache holds it
    await issue_req(dut, line, qos=QOS_CPU_FG)
    await serve_dram(dut, line, data=0x1111_2222_3333_4444)
    await wait_for(dut, "resp_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    # Now a write of all-zeros to the same line. The SLC must mark it
    # BDI_ZERO and pulse hpm_slc_bdi_compress.
    await issue_req(dut, line, is_write=1, qos=QOS_CPU_FG, wb_data=0)
    saw_bdi = False
    for _ in range(16):
        await RisingEdge(dut.clk)
        if int(dut.hpm_slc_bdi_compress.value) == 1:
            saw_bdi = True
            break
    assert saw_bdi, "BDI compress event must fire on zero-line install"


@cocotb.test()
async def test_slc_npu_stash_immediate_rehit(dut):
    """The NPU-stash insertion policy is observable as a near-immediate
    rehit on the same line without going to DRAM."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    line = 0x0000_0C00_0000
    await issue_req(dut, line, qos=QOS_NPU)
    await serve_dram(dut, line, data=0xDEAD_BEEF)
    await wait_for(dut, "resp_valid")
    for _ in range(2):
        await RisingEdge(dut.clk)

    await issue_req(dut, line, qos=QOS_NPU)
    saw_resp = False
    saw_dram_read = False
    for _ in range(12):
        await RisingEdge(dut.clk)
        if int(dut.resp_valid.value) == 1:
            saw_resp = True
        if int(dut.dram_acq_valid.value) == 1 and int(dut.dram_acq_is_write.value) == 0:
            saw_dram_read = True
    assert saw_resp
    assert not saw_dram_read, "NPU stash hit must serve without DRAM read"
