"""Cocotb unit tests for the uFTB (zero-bubble next-line predictor)."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_next_pc.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def uftb_cold_read_returns_pc_plus_block(dut):
    """A cold lookup must produce the fallthrough PC + 32 B and lkp_hit=0."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_0000
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 0
    assert int(dut.lkp_next_pc.value) == pc + 32
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


@cocotb.test()
async def uftb_train_and_hit(dut):
    """After a stored upd_next_pc, the same lookup should return that."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_8000
    nxt = 0x8001_0000

    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_next_pc.value = nxt
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0
    await RisingEdge(dut.clk)

    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await Timer(1, units="ps")
    assert int(dut.lkp_hit.value) == 1
    assert int(dut.lkp_next_pc.value) == nxt
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0
