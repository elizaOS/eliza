"""FDIP L1I prefetcher cocotb tests.

Verifies the FDIP-style L1I prefetcher (Reinman, Calder, Austin, 1999;
Kumar et al., arXiv:2006.13547). The RTL is a confidence-filtered
pass-through between the BPU's FTQ producer and the L1I prefetch port.

Tests reset/quiescence, confidence filtering, flush, ordered two-lane bundle
drain, duplicate suppression, and weak non-target pollution throttling.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

PADDR_W = 40
CONF_W = 3
REQ_W = PADDR_W + CONF_W + 1


def pack_req(paddr_line: int, confidence: int, branch_target: int) -> int:
    """Pack ftq_prefetch_req_t. Field order (MSB-first in declaration):
    paddr_line[39:0], confidence[2:0], branch_target.
    Packed structs lay out MSB-first; bit 0 is the last declared bit.
    """
    return (
        ((paddr_line & ((1 << PADDR_W) - 1)) << (CONF_W + 1))
        | ((confidence & ((1 << CONF_W) - 1)) << 1)
        | (branch_target & 0x1)
    )


def pack_bundle(lane0: int = 0, lane1: int = 0, valid: int = 0) -> int:
    """Pack ftq_prefetch_bundle_t as req[1], req[0], valid[1:0]."""
    return (
        ((lane1 & ((1 << REQ_W) - 1)) << (REQ_W + 2))
        | ((lane0 & ((1 << REQ_W) - 1)) << 2)
        | (valid & 0x3)
    )


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.ftq_in_valid.value = 0
    dut.ftq_in_req.value = 0
    dut.ftq_in_bundle.value = 0
    dut.pf_out_ready.value = 1
    dut.flush.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def pulse_ready(dut) -> None:
    dut.pf_out_ready.value = 1
    await RisingEdge(dut.clk)
    dut.pf_out_ready.value = 0


@cocotb.test()
async def test_fdip_reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    assert int(dut.pf_out_valid.value) == 0


@cocotb.test()
async def test_fdip_high_conf_passthrough(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0  # keep latched

    paddr = 0x0000_8000_4000
    dut.ftq_in_valid.value = 1
    dut.ftq_in_req.value = pack_req(paddr, confidence=5, branch_target=1)
    await RisingEdge(dut.clk)
    dut.ftq_in_valid.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
        if int(dut.pf_out_valid.value) == 1:
            break
    else:
        raise AssertionError("FDIP did not pass through a high-confidence request")


@cocotb.test()
async def test_fdip_low_conf_drop(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    paddr = 0x0000_8000_8000
    dut.ftq_in_valid.value = 1
    dut.ftq_in_req.value = pack_req(paddr, confidence=1, branch_target=0)
    await RisingEdge(dut.clk)
    dut.ftq_in_valid.value = 0
    for _ in range(6):
        await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0, "low-confidence request should be dropped"


@cocotb.test()
async def test_fdip_flush(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    paddr = 0x0000_8000_C000
    dut.ftq_in_valid.value = 1
    dut.ftq_in_req.value = pack_req(paddr, confidence=7, branch_target=1)
    await RisingEdge(dut.clk)
    dut.ftq_in_valid.value = 0
    await RisingEdge(dut.clk)
    # Now flush
    dut.flush.value = 1
    await RisingEdge(dut.clk)
    dut.flush.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0, "flush should drop in-flight prefetch"


@cocotb.test()
async def test_fdip_consumes_two_lane_bundle_in_order(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    first = pack_req(0x0000_8001_0000, confidence=4, branch_target=0)
    second = pack_req(0x0000_8001_0040, confidence=6, branch_target=1)
    dut.ftq_in_bundle.value = pack_bundle(first, second, valid=0b11)
    await Timer(1, units="ns")
    assert int(dut.ftq_in_ready_vec.value) == 0b11
    await RisingEdge(dut.clk)
    dut.ftq_in_bundle.value = 0

    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == first

    dut.pf_out_ready.value = 1
    await RisingEdge(dut.clk)
    dut.pf_out_ready.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == second


@cocotb.test()
async def test_fdip_suppresses_duplicate_bundle_line(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    line = pack_req(0x0000_8001_4000, confidence=6, branch_target=1)
    dut.ftq_in_bundle.value = pack_bundle(line, line, valid=0b11)
    await Timer(1, units="ns")
    assert int(dut.ftq_in_ready_vec.value) == 0b11
    await RisingEdge(dut.clk)
    dut.ftq_in_bundle.value = 0

    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == line

    await pulse_ready(dut)
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0, "duplicate line should not enqueue"


@cocotb.test()
async def test_fdip_suppresses_recent_duplicate_after_drain(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    line = pack_req(0x0000_8001_8000, confidence=7, branch_target=1)
    dut.ftq_in_valid.value = 1
    dut.ftq_in_req.value = line
    await RisingEdge(dut.clk)
    dut.ftq_in_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1

    await pulse_ready(dut)
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0

    dut.ftq_in_valid.value = 1
    dut.ftq_in_req.value = line
    await RisingEdge(dut.clk)
    dut.ftq_in_valid.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0, "recent duplicate should be dropped"


@cocotb.test()
async def test_fdip_throttles_weak_non_target_pollution(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    first = pack_req(0x0000_8002_0000, confidence=2, branch_target=0)
    second = pack_req(0x0000_8002_0040, confidence=2, branch_target=0)
    third = pack_req(0x0000_8002_0080, confidence=2, branch_target=0)

    dut.ftq_in_bundle.value = pack_bundle(first, second, valid=0b11)
    await RisingEdge(dut.clk)
    dut.ftq_in_bundle.value = 0
    await Timer(1, units="ns")
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == first

    dut.pf_out_ready.value = 1
    dut.ftq_in_bundle.value = pack_bundle(third, 0, valid=0b01)
    await Timer(1, units="ns")
    assert int(dut.ftq_in_ready_vec.value) == 0b01
    await RisingEdge(dut.clk)
    dut.pf_out_ready.value = 0
    dut.ftq_in_bundle.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == second

    await pulse_ready(dut)
    for _ in range(3):
        await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 0, "weak pollution request should be throttled"


@cocotb.test()
async def test_fdip_throttle_does_not_block_branch_target(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_out_ready.value = 0

    weak0 = pack_req(0x0000_8002_4000, confidence=2, branch_target=0)
    weak1 = pack_req(0x0000_8002_4040, confidence=2, branch_target=0)
    target = pack_req(0x0000_8002_4080, confidence=2, branch_target=1)

    dut.ftq_in_bundle.value = pack_bundle(weak0, weak1, valid=0b11)
    await RisingEdge(dut.clk)
    dut.ftq_in_bundle.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_req.value) == weak0

    dut.ftq_in_bundle.value = pack_bundle(target, 0, valid=0b01)
    await pulse_ready(dut)
    dut.ftq_in_bundle.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == weak1

    await pulse_ready(dut)
    await RisingEdge(dut.clk)
    assert int(dut.pf_out_valid.value) == 1
    assert int(dut.pf_out_req.value) == target
