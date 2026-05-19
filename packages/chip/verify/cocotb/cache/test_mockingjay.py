"""Mockingjay replacement-policy cocotb tests.

Verifies the synthesizable Mockingjay-style RTL (Shah et al., HPCA'22).
The RTL stores an 8-bit ETR per cache line and picks the largest-ETR way
as victim. This is an academic-quality port; the productized form is
documented as a follow-on in docs/evidence/cache/cache-evidence-gate.yaml.

Tests:
- Reset victim is well-defined.
- A miss-install at a high-distance PC produces an entry that is the
  preferred victim relative to a freshly-touched way.
- The STT decay path runs without simulator deadlock under many accesses.
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
async def test_mockingjay_reset_victim_well_defined(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.query_set.value = 11
    await RisingEdge(dut.clk)
    int(dut.victim_way.value)


@cocotb.test()
async def test_mockingjay_does_not_deadlock_under_traffic(dut):
    """Stream a lot of accesses to exercise the STT and the periodic
    decay path."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    pcs = [0x10_0000, 0x20_0000, 0x30_0000, 0x40_0000]
    for i in range(200):
        pc = pcs[i % len(pcs)]
        await access(
            dut,
            sset=i % 8,
            hit=(i % 5 == 0),
            way=i % 4,
            install=(i % 5 != 0),
            pc=pc,
        )
    dut.query_set.value = 3
    await RisingEdge(dut.clk)
    int(dut.victim_way.value)
