"""SPP (Signature Path Prefetcher) cocotb tests.

Verifies the synthesizable SPP-style prefetcher (Kim, Pugsley et al.,
MICRO'16). The RTL maintains a per-page Signature Table and a global
Pattern Table; on a demand access it updates the PT and emits a prefetch
when the new signature's best delta has confidence >= CONF_THRESHOLD.

Tests:
- Reset quiescence
- Repeated stride trains a PT entry to confidence and emits a prefetch
- A page boundary stops emitting (page-local prefetch)
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PAGE_BYTES = 4096
LINE_BYTES = 64
LINES_PER_PAGE = PAGE_BYTES // LINE_BYTES


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.obs_valid.value = 0
    dut.obs_paddr.value = 0
    dut.pf_ready.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def issue(dut, paddr: int) -> None:
    dut.obs_valid.value = 1
    dut.obs_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.obs_valid.value = 0
    await RisingEdge(dut.clk)


@cocotb.test()
async def test_spp_reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    assert int(dut.pf_valid.value) == 0


@cocotb.test()
async def test_spp_train_and_emit(dut):
    """SPP trains on the same delta across multiple pages, then emits a
    prefetch when the same signature re-occurs."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_ready.value = 0

    delta_lines = 1
    saw_pf = False
    # Train across several pages with delta = +1 line each step
    for page in range(8):
        page_base = (0x40_0000 + page) * PAGE_BYTES
        for off in range(8):
            await issue(dut, page_base + off * LINE_BYTES * delta_lines)
            if int(dut.pf_valid.value) == 1:
                saw_pf = True
                break
        if saw_pf:
            break
    assert saw_pf, "SPP did not emit a prefetch after training on a regular delta"
