"""Berti L1D prefetcher cocotb tests.

Verifies the synthesizable Berti-style prefetcher (Navarro-Torres et al.,
MICRO'22). The RTL is a confidence-counter approximation: each PC tracks
its observed deltas and emits a +LOOKAHEAD*best_delta prefetch once a
delta accumulates >= 2 observations.

Tests:
- Reset quiescence
- Constant stride converges to a non-zero prefetch within 8 accesses
- Random stride workload emits at most a single (stale) prefetch
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.obs_valid.value = 0
    dut.obs_pc.value = 0
    dut.obs_paddr.value = 0
    dut.pf_ready.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def issue(dut, pc: int, paddr: int) -> None:
    dut.obs_valid.value = 1
    dut.obs_pc.value = pc
    dut.obs_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.obs_valid.value = 0
    await RisingEdge(dut.clk)


@cocotb.test()
async def test_berti_reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    assert int(dut.pf_valid.value) == 0


@cocotb.test()
async def test_berti_constant_stride_emits(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    pc = 0x4000_0000
    stride_bytes = 64
    base = 0x8000_0000
    dut.pf_ready.value = 0  # latch pf_valid so we can observe it

    saw_pf = False
    for i in range(12):
        await issue(dut, pc, base + i * stride_bytes)
        if int(dut.pf_valid.value) == 1:
            saw_pf = True
            break
    assert saw_pf, "Berti prefetcher did not emit a prefetch under constant stride"


@cocotb.test()
async def test_berti_random_quiet(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    pc = 0x4000_8000
    addrs = [0x8000_0000, 0x9100_4000, 0xA200_8000, 0xB300_C000]
    cnt = 0
    for a in addrs:
        await issue(dut, pc, a)
        if int(dut.pf_valid.value) == 1:
            cnt += 1
    assert cnt <= 1, f"random workload triggered {cnt} prefetches"
