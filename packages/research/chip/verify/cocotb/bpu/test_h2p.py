"""Cocotb unit tests for the H2P direction sidecar."""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

H2P_FEATURES = 48


async def reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.lkp_hist.value = 0
    dut.lkp_target_hist.value = 0
    dut.lkp_path_hist.value = 0
    dut.upd_valid.value = 0
    dut.upd_pc.value = 0
    dut.upd_hist.value = 0
    dut.upd_target_hist.value = 0
    dut.upd_path_hist.value = 0
    dut.upd_taken.value = 0
    dut.test_corrupt_parity_valid.value = 0
    dut.test_corrupt_parity_pc.value = 0
    dut.test_corrupt_parity_feature.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def drive_update(dut, pc, taken=True, hist=0):
    dut.upd_valid.value = 1
    dut.upd_pc.value = pc
    dut.upd_hist.value = hist
    dut.upd_target_hist.value = 0
    dut.upd_path_hist.value = 0
    dut.upd_taken.value = int(taken)
    await RisingEdge(dut.clk)
    dut.upd_valid.value = 0


async def lookup(dut, pc, hist=0):
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    dut.lkp_hist.value = hist
    dut.lkp_target_hist.value = 0
    dut.lkp_path_hist.value = 0
    await Timer(1, units="ps")
    return int(dut.lkp_override.value), int(dut.lkp_taken.value)


async def corrupt_feature(dut, pc, feature):
    dut.test_corrupt_parity_pc.value = pc
    dut.test_corrupt_parity_feature.value = feature
    dut.test_corrupt_parity_valid.value = 1
    await RisingEdge(dut.clk)
    dut.test_corrupt_parity_valid.value = 0


@cocotb.test()
async def h2p_trains_strong_taken_override(dut):
    """Repeated same-direction updates should produce a strong H2P override."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_7000
    for _ in range(40):
        await drive_update(dut, pc, taken=True)

    override, taken = await lookup(dut, pc)
    assert override == 1
    assert taken == 1
    dut.lkp_valid.value = 0


@cocotb.test()
async def h2p_parity_error_neutralizes_poisoned_weights(dut):
    """Corrupted H2P weights must contribute neutral zero, not steer."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_7100
    for _ in range(40):
        await drive_update(dut, pc, taken=True)

    override, taken = await lookup(dut, pc)
    assert override == 1
    assert taken == 1

    for feature in range(H2P_FEATURES + 1):
        await corrupt_feature(dut, pc, feature)

    override, _ = await lookup(dut, pc)
    assert override == 0

    for _ in range(40):
        await drive_update(dut, pc, taken=True)

    override, taken = await lookup(dut, pc)
    assert override == 1
    assert taken == 1
    dut.lkp_valid.value = 0
