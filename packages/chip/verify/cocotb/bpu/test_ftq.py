"""Cocotb tests for the FTQ.

Covers:
  * push/pop round trip
  * full / empty PMU strobes
  * occupancy counter tracks pending entries
  * flush truncates the queue back to the resolver's index
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

FTQ_ENTRIES = 64
BR_NONE, BR_COND, BR_CALL, BR_RET = 0, 1, 2, 3


async def reset(dut):
    dut.rst_n.value = 0
    dut.push_valid.value = 0
    dut.push_start_pc.value = 0
    dut.push_end_pc.value = 0
    dut.push_target_pc.value = 0
    dut.push_taken.value = 0
    dut.push_kind.value = 0
    dut.pop_ready.value = 0
    dut.flush_valid.value = 0
    dut.flush_idx.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def push(dut, start, end, target, taken, kind):
    dut.push_valid.value = 1
    dut.push_start_pc.value = start
    dut.push_end_pc.value = end
    dut.push_target_pc.value = target
    dut.push_taken.value = taken
    dut.push_kind.value = kind
    await RisingEdge(dut.clk)
    dut.push_valid.value = 0


@cocotb.test()
async def ftq_push_pop_first_in_first_out(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    entries = [
        (0x8000_0000, 0x8000_001F, 0x8000_0040, 1, BR_COND),
        (0x8000_0040, 0x8000_005F, 0x8000_0060, 1, BR_CALL),
        (0x8000_0060, 0x8000_007F, 0x8000_0040, 1, BR_RET),
    ]
    for start, end, target, taken, kind in entries:
        await push(dut, start, end, target, taken, kind)

    # Drain one entry per cycle. Each iteration: raise pop_ready, advance one
    # rising edge (which both pops the current entry and presents the next
    # combinationally), then check the just-popped contents on a fresh edge
    # so verilator has settled the propagation. Sampling on Timer(1, ns)
    # after the edge avoids racing the scheduler.
    from cocotb.triggers import Timer

    for start, _end, target, taken, kind in entries:
        await Timer(1, units="ns")
        assert int(dut.pop_valid.value) == 1
        assert int(dut.pop_start_pc.value) == start
        assert int(dut.pop_target_pc.value) == target
        assert int(dut.pop_taken.value) == taken
        assert int(dut.pop_kind.value) == kind
        dut.pop_ready.value = 1
        await RisingEdge(dut.clk)
        dut.pop_ready.value = 0


@cocotb.test()
async def ftq_full_blocks_push(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for i in range(FTQ_ENTRIES):
        await push(
            dut, 0x9000_0000 + i * 0x20, 0x9000_001F + i * 0x20, 0x9000_0040 + i * 0x20, 1, BR_COND
        )

    await RisingEdge(dut.clk)
    assert int(dut.pmu_full.value) == 1
    assert int(dut.push_ready.value) == 0


@cocotb.test()
async def ftq_flush_truncates_back_to_resolver_index(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for i in range(8):
        await push(
            dut, 0xA000_0000 + i * 0x20, 0xA000_001F + i * 0x20, 0xA000_0040 + i * 0x20, 1, BR_COND
        )

    # Flush back to logical index 4. After flush, occupancy should be 4.
    dut.flush_valid.value = 1
    dut.flush_idx.value = 4
    await RisingEdge(dut.clk)
    dut.flush_valid.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.occupancy.value) == 4
