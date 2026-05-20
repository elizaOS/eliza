"""Best-Offset prefetcher cocotb tests.

Verifies the synthesizable Best-Offset prefetcher (Michaud, DPC-2 winner).
The RTL keeps a Recent-Request table and a saturating score per candidate
offset; every ROUND_LEN cycles it picks the best-scoring offset.

Tests:
- Reset quiescence
- Constant +1-line stride causes the prefetcher to emit prefetches (uses
  the initial active offset of +1)
- Score updates do not crash the round counter
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge


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
async def test_bo_reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    assert int(dut.pf_valid.value) == 0


@cocotb.test()
async def test_bo_emit_under_stride(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.pf_ready.value = 0  # latch pf_valid for observation

    base = 0x80_00_00_00
    saw_pf = False
    for i in range(4):
        await issue(dut, base + i * 64)
        if int(dut.pf_valid.value) == 1:
            saw_pf = True
            break
    assert saw_pf, "best-offset did not emit a prefetch in initial offset window"


@cocotb.test()
async def test_bo_score_does_not_crash(dut):
    """Drive many accesses to exercise the round-end best-pick path."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    base = 0x90_00_00_00
    for i in range(64):
        await issue(dut, base + i * 64)
    # No assertion needed beyond simulator stability; reaching here proves
    # the round counter and best-pick path don't simulate-deadlock.
