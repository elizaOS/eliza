"""Cocotb tests for the FTQ.

Covers:
  * push/pop round trip
  * full / empty PMU strobes
  * occupancy counter tracks pending entries
  * flush truncates the queue back to the resolver's index
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

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
    dut.push_ras_restore_valid.value = 0
    dut.push_ras_restore_addr.value = 0
    dut.push_ghist_snapshot.value = 0
    dut.push_ittage_hist_snapshot.value = 0
    dut.push_ittage_target_hist_snapshot.value = 0
    dut.push_ittage_path_hist_snapshot.value = 0
    dut.push_tage_provider.value = 0
    dut.push_ittage_provider.value = 0
    dut.push_tage_provider_ctr.value = 0
    dut.push_tage_lowconf.value = 0
    dut.push_sc_override.value = 0
    dut.push_sc_taken.value = 0
    dut.pop_ready.value = 0
    dut.replay_idx.value = 0
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
    dut.push_ras_restore_valid.value = 0
    dut.push_ras_restore_addr.value = 0
    dut.push_ghist_snapshot.value = 0
    dut.push_ittage_hist_snapshot.value = 0
    dut.push_ittage_target_hist_snapshot.value = 0
    dut.push_ittage_path_hist_snapshot.value = 0
    dut.push_tage_provider.value = 0
    dut.push_ittage_provider.value = 0
    dut.push_tage_provider_ctr.value = 0
    dut.push_tage_lowconf.value = 0
    dut.push_sc_override.value = 0
    dut.push_sc_taken.value = 0
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

    for idx, (start, _end, target, taken, kind) in enumerate(entries):
        await Timer(1, units="ns")
        assert int(dut.pop_valid.value) == 1
        assert int(dut.pop_start_pc.value) == start
        assert int(dut.pop_target_pc.value) == target
        assert int(dut.pop_taken.value) == taken
        assert int(dut.pop_kind.value) == kind
        assert int(dut.pop_ftq_idx.value) == idx
        dut.pop_ready.value = 1
        await RisingEdge(dut.clk)
        dut.pop_ready.value = 0


@cocotb.test()
async def ftq_preserves_prediction_snapshots(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    dut.push_valid.value = 1
    dut.push_start_pc.value = 0x8100_0000
    dut.push_end_pc.value = 0x8100_001F
    dut.push_target_pc.value = 0x8100_0400
    dut.push_taken.value = 1
    dut.push_kind.value = BR_COND
    dut.push_ras_restore_valid.value = 1
    dut.push_ras_restore_addr.value = 0x8100_0020
    dut.push_ghist_snapshot.value = 0x1234_5678_9ABC
    dut.push_ittage_hist_snapshot.value = 0xBEEF_CAFE_0123
    dut.push_ittage_target_hist_snapshot.value = 0x00DE_ADBE_EF01
    dut.push_ittage_path_hist_snapshot.value = 0x0000_C0DE_1234
    dut.push_tage_provider.value = 3
    dut.push_ittage_provider.value = 4
    dut.push_tage_provider_ctr.value = 0b100
    dut.push_tage_lowconf.value = 1
    dut.push_sc_override.value = 1
    dut.push_sc_taken.value = 0
    await RisingEdge(dut.clk)
    dut.push_valid.value = 0

    await Timer(1, units="ns")
    assert int(dut.pop_valid.value) == 1
    dut.replay_idx.value = 0
    await Timer(1, units="ns")
    assert int(dut.replay_start_pc.value) == 0x8100_0000
    assert int(dut.replay_target_pc.value) == 0x8100_0400
    assert int(dut.replay_taken.value) == 1
    assert int(dut.replay_kind.value) == BR_COND
    assert int(dut.replay_ftq_idx.value) == 0
    assert int(dut.replay_ghist_snapshot.value) == 0x1234_5678_9ABC
    assert int(dut.replay_ittage_hist_snapshot.value) == 0xBEEF_CAFE_0123
    assert int(dut.replay_tage_provider.value) == 3
    assert int(dut.replay_ittage_provider.value) == 4
    assert int(dut.replay_tage_lowconf.value) == 1
    assert int(dut.pop_ras_restore_valid.value) == 1
    assert int(dut.pop_ras_restore_addr.value) == 0x8100_0020
    assert int(dut.pop_ghist_snapshot.value) == 0x1234_5678_9ABC
    assert int(dut.pop_ittage_hist_snapshot.value) == 0xBEEF_CAFE_0123
    assert int(dut.pop_ittage_target_hist_snapshot.value) == 0x00DE_ADBE_EF01
    assert int(dut.pop_ittage_path_hist_snapshot.value) == 0x0000_C0DE_1234
    assert int(dut.pop_tage_provider.value) == 3
    assert int(dut.pop_ittage_provider.value) == 4
    assert int(dut.pop_tage_provider_ctr.value) == 0b100
    assert int(dut.pop_tage_lowconf.value) == 1
    assert int(dut.pop_sc_override.value) == 1
    assert int(dut.pop_sc_taken.value) == 0


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
async def ftq_full_accepts_push_when_pop_frees_slot(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    base = 0x9800_0000
    for i in range(FTQ_ENTRIES):
        await push(
            dut, base + i * 0x20, base + 0x1F + i * 0x20, base + 0x40 + i * 0x20, 1, BR_COND
        )

    await RisingEdge(dut.clk)
    assert int(dut.pmu_full.value) == 1
    assert int(dut.push_ready.value) == 0

    tail = base + FTQ_ENTRIES * 0x20
    dut.pop_ready.value = 1
    dut.push_valid.value = 1
    dut.push_start_pc.value = tail
    dut.push_end_pc.value = tail + 0x1F
    dut.push_target_pc.value = tail + 0x40
    dut.push_taken.value = 1
    dut.push_kind.value = BR_COND
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")
    assert int(dut.push_ready.value) == 1
    assert int(dut.pop_start_pc.value) == base + 0x20
    dut.push_valid.value = 0

    seen = []
    for _ in range(FTQ_ENTRIES * 2):
        await RisingEdge(dut.clk)
        if int(dut.pop_valid.value):
            seen.append(int(dut.pop_start_pc.value))
        if seen and seen[-1] == tail:
            break
    dut.pop_ready.value = 0

    assert seen[-1] == tail
    assert len(seen) == FTQ_ENTRIES


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
