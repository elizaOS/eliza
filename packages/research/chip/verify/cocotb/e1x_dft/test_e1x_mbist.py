from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

DEPTH = 64
MAX_CYCLES = 4000


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.start.value = 0
    dut.inject_valid.value = 0
    dut.inject_addr.value = 0
    dut.inject_bit.value = 0
    dut.inject_value.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def run_to_done(dut) -> None:
    dut.start.value = 1
    await RisingEdge(dut.clk)
    dut.start.value = 0
    for _ in range(MAX_CYCLES):
        await RisingEdge(dut.clk)
        await Timer(1, units="ns")
        if int(dut.done.value) == 1:
            return
    raise AssertionError("MBIST did not complete within cycle budget")


@cocotb.test()
async def mbist_passes_clean_memory(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    # No injection: clean SRAM model -> March C- must complete with fail=0.
    await run_to_done(dut)
    assert int(dut.fail.value) == 0, "clean memory reported a fault"
    assert int(dut.busy.value) == 0, "controller still busy after done"


async def inject_and_run(dut, addr: int, bit: int, value: int) -> None:
    dut.inject_addr.value = addr
    dut.inject_bit.value = bit
    dut.inject_value.value = value
    dut.inject_valid.value = 1
    await RisingEdge(dut.clk)
    dut.inject_valid.value = 0
    await Timer(1, units="ns")
    await run_to_done(dut)


@cocotb.test()
async def mbist_detects_stuck_at_one(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    # Stuck-at-1 at word address 37, bit 11. M0 writes 0; the cell holds 1;
    # the first read element (M1 r0) at that address must mismatch.
    addr, bit = 37, 11
    await inject_and_run(dut, addr, bit, 1)
    assert int(dut.fail.value) == 1, "stuck-at-1 fault not detected"
    assert int(dut.fail_addr.value) == addr, (
        f"wrong failing address: {int(dut.fail_addr.value)} != {addr}"
    )
    assert int(dut.fail_bit.value) == bit, f"wrong failing bit: {int(dut.fail_bit.value)} != {bit}"
    # Expected 0 background, actual has the stuck bit set.
    assert int(dut.fail_expected.value) == 0
    assert int(dut.fail_actual.value) == (1 << bit)


@cocotb.test()
async def mbist_detects_stuck_at_zero(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    # Stuck-at-0 at address 0, bit 0. Detected by the first r1 element (M2),
    # where the cell should read 1 but is stuck at 0.
    addr, bit = 0, 0
    await inject_and_run(dut, addr, bit, 0)
    assert int(dut.fail.value) == 1, "stuck-at-0 fault not detected"
    assert int(dut.fail_addr.value) == addr, (
        f"wrong failing address: {int(dut.fail_addr.value)} != {addr}"
    )
    assert int(dut.fail_bit.value) == bit
    assert int(dut.fail_expected.value) == 0xFFFF_FFFF
    assert int(dut.fail_actual.value) == (0xFFFF_FFFF & ~(1 << bit))
