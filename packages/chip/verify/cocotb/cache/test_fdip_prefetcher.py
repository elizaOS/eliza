"""FDIP L1I prefetcher cocotb tests.

Verifies the FDIP-style L1I prefetcher (Reinman, Calder, Austin, 1999;
Kumar et al., arXiv:2006.13547). The RTL is a confidence-filtered
pass-through between the BPU's FTQ producer and the L1I prefetch port.

Tests:
- Reset quiescence
- High-confidence FTQ request passes through to the L1I prefetch port
- Low-confidence FTQ request is dropped (below MIN_CONF)
- Flush drops in-flight requests
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PADDR_W = 40
CONF_W = 3


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


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.ftq_in_valid.value = 0
    dut.ftq_in_req.value = 0
    dut.pf_out_ready.value = 1
    dut.flush.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


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
