"""L1I cache basic cocotb tests.

Exercises:
- reset behavior
- demand miss -> L2 refill -> IFU response
- back-invalidate via probe and re-miss after invalidate
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.ifu_req_valid.value = 0
    dut.ifu_req_paddr.value = 0
    dut.ifu_flush.value = 0
    dut.ftq_req_valid.value = 0
    dut.ftq_req.value = 0
    dut.miss_ready.value = 1
    dut.refill_valid.value = 0
    dut.refill_data.value = 0
    dut.refill_beat_idx.value = 0
    dut.refill_last.value = 0
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for(dut, signal_name, max_cycles=64):
    """Polls a 1-bit signal each cycle. Returns the cycle count on assert."""
    for cyc in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal_name).value) == 1:
            return cyc
    raise AssertionError(f"{signal_name} never asserted within {max_cycles} cycles")


async def serve_refill(dut, beats=None) -> None:
    """Serve a 4-beat × 128-bit refill once miss_valid is up."""
    if beats is None:
        beats = [
            0x0000_0000_0000_0001_0000_0000_0000_0000,
            0x0000_0000_0000_0003_0000_0000_0000_0002,
            0x0000_0000_0000_0005_0000_0000_0000_0004,
            0x0000_0000_0000_0007_0000_0000_0000_0006,
        ]
    await wait_for(dut, "miss_valid")
    # After miss is ack'd (since miss_ready=1 always), drive refill
    for i, beat in enumerate(beats):
        dut.refill_valid.value = 1
        dut.refill_data.value = beat
        dut.refill_beat_idx.value = i
        dut.refill_last.value = 1 if i == 3 else 0
        await RisingEdge(dut.clk)
    dut.refill_valid.value = 0
    dut.refill_last.value = 0


@cocotb.test()
async def test_l1i_reset_quiescent(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    await RisingEdge(dut.clk)
    assert int(dut.ifu_resp_valid.value) == 0
    assert int(dut.miss_valid.value) == 0


@cocotb.test()
async def test_l1i_demand_miss_then_hit(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_8000_4000  # 64 B-aligned
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0

    await serve_refill(dut)

    # After install, the L1I emits one ifu_resp_valid on critical-word path.
    await wait_for(dut, "ifu_resp_valid")

    # Re-issue: should be a clean hit (no second miss_valid pulse).
    for _ in range(2):
        await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for(dut, "ifu_resp_valid", max_cycles=20)


@cocotb.test()
async def test_l1i_probe_invalidate(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_8000_8000
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await serve_refill(dut)
    await wait_for(dut, "ifu_resp_valid")

    # Probe-invalidate the line
    for _ in range(2):
        await RisingEdge(dut.clk)
    dut.probe_valid.value = 1
    dut.probe_paddr_line.value = paddr
    await RisingEdge(dut.clk)
    dut.probe_valid.value = 0
    await wait_for(dut, "probe_ack", max_cycles=8)

    # Next access to the same line must miss again
    for _ in range(2):
        await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for(dut, "miss_valid", max_cycles=16)
