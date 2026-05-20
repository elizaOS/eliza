"""Hawkeye replacement-policy cocotb tests.

Verifies the synthesizable Hawkeye-style RTL (Jain & Lin, ISCA'16). The
RTL keeps a 3-bit per-PC predictor and a 3-bit RRPV per way. Cache-friendly
PCs insert at RRPV=0, cache-averse PCs at RRPV=7.

Tests:
- Reset victim is some valid way (all start at RRPV=7)
- Repeated hits from the same PC keep the predictor cache-friendly so
  follow-on miss-installs do not become immediate victims
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.acc_valid.value = 0
    dut.acc_set.value = 0
    dut.acc_hit.value = 0
    dut.acc_way.value = 0
    dut.acc_is_miss_install.value = 0
    dut.acc_pc.value = 0
    dut.query_set.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def access(dut, sset: int, hit: bool, way: int, install: bool, pc: int) -> None:
    dut.acc_valid.value = 1
    dut.acc_set.value = sset
    dut.acc_hit.value = 1 if hit else 0
    dut.acc_way.value = way
    dut.acc_is_miss_install.value = 1 if install else 0
    dut.acc_pc.value = pc
    await RisingEdge(dut.clk)
    dut.acc_valid.value = 0
    dut.acc_hit.value = 0
    dut.acc_is_miss_install.value = 0
    await RisingEdge(dut.clk)


@cocotb.test()
async def test_hawkeye_reset_victim_well_defined(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.query_set.value = 3
    await RisingEdge(dut.clk)
    int(dut.victim_way.value)


@cocotb.test()
async def test_hawkeye_friendly_pc_protects_install(dut):
    """Train a PC's predictor to cache-friendly via several hits, then
    miss-install at that PC and confirm the install is not immediately
    chosen as victim."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    friendly_pc = 0x0000_0000_0010_0000
    # Drive 4 hits from friendly_pc on way 5, set 7
    for _ in range(4):
        await access(dut, sset=7, hit=True, way=5, install=False, pc=friendly_pc)

    # Now miss-install at way 2 from friendly_pc; should insert at RRPV=0
    await access(dut, sset=7, hit=False, way=2, install=True, pc=friendly_pc)
    dut.query_set.value = 7
    await RisingEdge(dut.clk)
    v = int(dut.victim_way.value)
    # Way 2 was just installed at RRPV=0 if predictor is friendly
    assert v != 2, f"freshly installed friendly-PC line became victim, v={v}"
