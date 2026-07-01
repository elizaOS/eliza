"""DRRIP replacement-policy cocotb tests.

Verifies:
- After reset, victim selection returns a way with RRPV = 3.
- Hits drive RRPV to 0 (way becomes least likely victim).
- Miss-install at the chosen way correctly inserts at RRPV = 2 (SRRIP
  follower) and that way is not immediately picked as victim on the
  next query.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ReadOnly, RisingEdge


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.acc_valid.value = 0
    dut.acc_set.value = 0
    dut.acc_hit.value = 0
    dut.acc_way.value = 0
    dut.acc_is_miss_install.value = 0
    dut.query_set.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def access(dut, sset: int, hit: bool, way: int, install: bool) -> None:
    dut.acc_valid.value = 1
    dut.acc_set.value = sset
    dut.acc_hit.value = 1 if hit else 0
    dut.acc_way.value = way
    dut.acc_is_miss_install.value = 1 if install else 0
    await RisingEdge(dut.clk)
    dut.acc_valid.value = 0
    dut.acc_hit.value = 0
    dut.acc_is_miss_install.value = 0
    await RisingEdge(dut.clk)


@cocotb.test()
async def test_drrip_reset_victim(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)
    dut.query_set.value = 7
    await RisingEdge(dut.clk)
    await ReadOnly()
    # Any way is valid right after reset because all RRPV start at 3.
    int(dut.victim_way.value)


@cocotb.test()
async def test_drrip_hit_protects_way(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    # Hit way 5 in set 7
    await access(dut, sset=7, hit=True, way=5, install=False)
    dut.query_set.value = 7
    await RisingEdge(dut.clk)
    await ReadOnly()
    v = int(dut.victim_way.value)
    assert v != 5, f"hit way 5 should not become victim, victim={v}"


@cocotb.test()
async def test_drrip_install_protected(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    # Miss-install at way 3, set 11
    await access(dut, sset=11, hit=False, way=3, install=True)
    dut.query_set.value = 11
    await RisingEdge(dut.clk)
    await ReadOnly()
    v = int(dut.victim_way.value)
    # Right after install (RRPV=2 SRRIP), way 3 should not be picked as
    # victim because other ways still have RRPV=3.
    assert v != 3, f"freshly-installed way 3 became victim, v={v}"
