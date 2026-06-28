"""BPU-to-L1I frontend integration tests.

This module proves the narrow positive path that was missing from the
cross-domain smoke test: a trained taken target leaves bpu_top, crosses the
FTQ-to-L1I shim, passes the FDIP confidence filter, fills L1I as a prefetch,
and is later consumed by an IFU demand access as a useful prefetch hit.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

BR_COND = 1
BR_CALL = 2
BR_NONE = 0
BR_DIRECT = 5
PMU_FTQ_FULL = 12


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.fetch_pop.value = 0
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0
    dut.resolve_pc.value = 0
    dut.resolve_target.value = 0
    dut.resolve_call_return_pc.value = 0
    dut.resolve_taken.value = 0
    dut.resolve_kind.value = 0
    dut.resolve_ftq_idx.value = 0
    dut.resolve_ras_restore_top.value = 0
    dut.ifu_req_valid.value = 0
    dut.ifu_req_paddr.value = 0
    dut.ifu_flush.value = 0
    dut.miss_ready.value = 1
    dut.miss_ready_lane1.value = 1
    dut.refill_valid.value = 0
    dut.refill_data.value = 0
    dut.refill_beat_idx.value = 0
    dut.refill_last.value = 0
    dut.refill_valid_lane1.value = 0
    dut.refill_data_lane1.value = 0
    dut.refill_beat_idx_lane1.value = 0
    dut.refill_last_lane1.value = 0
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
    dut.shim_l1i_ready_vec.value = 0
    dut.fdip_bundle_enable.value = 1
    dut.fetch_demand_enable.value = 0
    for _ in range(6):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def pulse_lookup(dut, pc: int) -> None:
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = pc
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0


async def pulse_resolve(
    dut,
    pc: int,
    target: int,
    *,
    kind: int = BR_CALL,
    taken: bool = True,
    misp: bool = True,
) -> None:
    dut.resolve_valid.value = 1
    dut.resolve_misp.value = 1 if misp else 0
    dut.resolve_pc.value = pc
    dut.resolve_target.value = target
    dut.resolve_call_return_pc.value = pc + 4
    dut.resolve_taken.value = 1 if taken else 0
    dut.resolve_kind.value = kind
    dut.resolve_ftq_idx.value = 0
    dut.resolve_ras_restore_top.value = 0
    await RisingEdge(dut.clk)
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0


async def wait_for_high(dut, signal_name: str, max_cycles: int = 64) -> int:
    for cycle in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal_name).value) == 1:
            return cycle
    raise AssertionError(f"{signal_name} did not assert within {max_cycles} cycles")


async def wait_for_low(dut, signal_name: str, max_cycles: int = 16) -> int:
    for cycle in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal_name).value) == 0:
            return cycle
    raise AssertionError(f"{signal_name} did not deassert within {max_cycles} cycles")


async def serve_refill(
    dut,
    *,
    expected_prefetch: bool | None = None,
    expected_line: int | None = None,
) -> None:
    await wait_for_high(dut, "miss_valid", max_cycles=80)
    if expected_prefetch is not None:
        assert int(dut.miss_is_prefetch.value) == int(expected_prefetch)
    if expected_line is not None:
        assert int(dut.miss_paddr_line.value) == expected_line
    for beat_idx, beat in enumerate(
        (
            0x0000_0000_0000_0101_0000_0000_0000_0100,
            0x0000_0000_0000_0103_0000_0000_0000_0102,
            0x0000_0000_0000_0105_0000_0000_0000_0104,
            0x0000_0000_0000_0107_0000_0000_0000_0106,
        )
    ):
        dut.refill_valid.value = 1
        dut.refill_data.value = beat
        dut.refill_beat_idx.value = beat_idx
        dut.refill_last.value = 1 if beat_idx == 3 else 0
        await RisingEdge(dut.clk)
    dut.refill_valid.value = 0
    dut.refill_last.value = 0


async def serve_refill_lane1(
    dut,
    *,
    expected_prefetch: bool | None = None,
    expected_line: int | None = None,
) -> None:
    await wait_for_high(dut, "miss_valid_lane1", max_cycles=80)
    if expected_prefetch is not None:
        assert int(dut.miss_is_prefetch_lane1.value) == int(expected_prefetch)
    if expected_line is not None:
        assert int(dut.miss_paddr_line_lane1.value) == expected_line
    for beat_idx, beat in enumerate(
        (
            0x0000_0000_0000_0201_0000_0000_0000_0200,
            0x0000_0000_0000_0203_0000_0000_0000_0202,
            0x0000_0000_0000_0205_0000_0000_0000_0204,
            0x0000_0000_0000_0207_0000_0000_0000_0206,
        )
    ):
        dut.refill_valid_lane1.value = 1
        dut.refill_data_lane1.value = beat
        dut.refill_beat_idx_lane1.value = beat_idx
        dut.refill_last_lane1.value = 1 if beat_idx == 3 else 0
        await RisingEdge(dut.clk)
    dut.refill_valid_lane1.value = 0
    dut.refill_last_lane1.value = 0


async def serve_refill_after_asserted(dut) -> None:
    assert int(dut.miss_valid.value) == 1
    dut.miss_ready.value = 1
    await RisingEdge(dut.clk)
    for beat_idx, beat in enumerate(
        (
            0x0000_0000_0000_0301_0000_0000_0000_0300,
            0x0000_0000_0000_0303_0000_0000_0000_0302,
            0x0000_0000_0000_0305_0000_0000_0000_0304,
            0x0000_0000_0000_0307_0000_0000_0000_0306,
        )
    ):
        dut.refill_valid.value = 1
        dut.refill_data.value = beat
        dut.refill_beat_idx.value = beat_idx
        dut.refill_last.value = 1 if beat_idx == 3 else 0
        await RisingEdge(dut.clk)
    dut.refill_valid.value = 0
    dut.refill_last.value = 0


async def serve_refill_lane1_after_asserted(dut) -> None:
    assert int(dut.miss_valid_lane1.value) == 1
    dut.miss_ready_lane1.value = 1
    await RisingEdge(dut.clk)
    for beat_idx, beat in enumerate(
        (
            0x0000_0000_0000_0401_0000_0000_0000_0400,
            0x0000_0000_0000_0403_0000_0000_0000_0402,
            0x0000_0000_0000_0405_0000_0000_0000_0404,
            0x0000_0000_0000_0407_0000_0000_0000_0406,
        )
    ):
        dut.refill_valid_lane1.value = 1
        dut.refill_data_lane1.value = beat
        dut.refill_beat_idx_lane1.value = beat_idx
        dut.refill_last_lane1.value = 1 if beat_idx == 3 else 0
        await RisingEdge(dut.clk)
    dut.refill_valid_lane1.value = 0
    dut.refill_last_lane1.value = 0


async def wait_for_demand_prefetch_hit(dut, max_cycles: int = 40) -> None:
    saw_resp = False
    saw_useful_prefetch = False
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        saw_resp |= int(dut.ifu_resp_valid.value) == 1
        saw_useful_prefetch |= int(dut.hpm_l1i_prefetch.value) == 1
        if saw_resp and saw_useful_prefetch:
            assert int(dut.ifu_resp_paddr_eq_req.value) == 1
            return
    raise AssertionError(
        "demand did not hit a prefetched L1I line "
        f"(resp={saw_resp}, useful_prefetch={saw_useful_prefetch})"
    )


async def fill_l1i_demand_line(dut, paddr: int) -> None:
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = paddr
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await serve_refill(dut, expected_prefetch=False, expected_line=(paddr & ~0x3F))
    await wait_for_high(dut, "ifu_resp_valid", max_cycles=40)
    for _ in range(2):
        await RisingEdge(dut.clk)


async def pop_until_shim_valid(dut, max_cycles: int = 24) -> None:
    dut.fetch_pop.value = 1
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(dut.shim_l1i_valid.value) == 1:
            dut.fetch_pop.value = 0
            return
    dut.fetch_pop.value = 0
    raise AssertionError("BPU fetch pop did not produce a shim L1I request")


async def collect_shim_requests(
    dut, count: int, max_cycles: int = 48
) -> list[tuple[int, int, int]]:
    requests: list[tuple[int, int, int]] = []
    dut.fetch_pop.value = 1
    try:
        for _ in range(max_cycles):
            await RisingEdge(dut.clk)
            if int(dut.shim_l1i_valid.value) == 1:
                requests.append(
                    (
                        int(dut.shim_l1i_paddr_line.value),
                        int(dut.shim_l1i_branch_target.value),
                        int(dut.shim_l1i_confidence.value),
                    )
                )
                if len(requests) == count:
                    return requests
    finally:
        dut.fetch_pop.value = 0
    raise AssertionError(f"collected {len(requests)} shim requests, expected {count}")


async def wait_for_wide_shim_valid(dut, mask: int, max_cycles: int = 48) -> None:
    dut.fetch_pop.value = 1
    try:
        for _ in range(max_cycles):
            await RisingEdge(dut.clk)
            if (int(dut.shim_l1i_valid_vec.value) & mask) == mask:
                return
    finally:
        dut.fetch_pop.value = 0
    raise AssertionError(
        f"wide shim valid mask 0x{mask:x} did not assert; "
        f"observed 0x{int(dut.shim_l1i_valid_vec.value):x}"
    )


async def wait_for_fetch_stream_valid(dut, mask: int, max_cycles: int = 48) -> None:
    dut.fetch_pop.value = 1
    try:
        for _ in range(max_cycles):
            await RisingEdge(dut.clk)
            if (int(dut.fetch_stream_valid.value) & mask) == mask:
                return
    finally:
        dut.fetch_pop.value = 0
    raise AssertionError(
        f"fetch stream valid mask 0x{mask:x} did not assert; "
        f"observed 0x{int(dut.fetch_stream_valid.value):x}"
    )


async def drive_fetch_stream_into_demand_queue(dut, mask: int, max_cycles: int = 48) -> None:
    dut.fetch_pop.value = 1
    try:
        for _ in range(max_cycles):
            await RisingEdge(dut.clk)
            if (int(dut.fetch_stream_valid.value) & mask) == mask:
                await RisingEdge(dut.clk)
                return
    finally:
        dut.fetch_pop.value = 0
    raise AssertionError(
        f"fetch stream mask 0x{mask:x} was not queued for demand; "
        f"observed 0x{int(dut.fetch_stream_valid.value):x}"
    )


async def drive_fetch_stream_until_wide_demand_accept(dut, mask: int, max_cycles: int = 48) -> None:
    dut.fetch_pop.value = 1
    saw_stream = False
    try:
        for _ in range(max_cycles):
            await RisingEdge(dut.clk)
            saw_stream |= (int(dut.fetch_stream_valid.value) & mask) == mask
            if (
                saw_stream
                and int(dut.fetch_demand_valid.value) == 1
                and int(dut.fetch_demand_ready.value) == 1
                and int(dut.fetch_demand_valid_lane1.value) == 1
                and int(dut.fetch_demand_ready_lane1.value) == 1
            ):
                return
    finally:
        dut.fetch_pop.value = 0
    raise AssertionError(
        "fetch stream did not issue both target-block lanes to L1I "
        f"(stream_seen={saw_stream}, stream=0x{int(dut.fetch_stream_valid.value):x}, "
        f"lane0_valid={int(dut.fetch_demand_valid.value)}, "
        f"lane0_ready={int(dut.fetch_demand_ready.value)}, "
        f"lane1_valid={int(dut.fetch_demand_valid_lane1.value)}, "
        f"lane1_ready={int(dut.fetch_demand_ready_lane1.value)})"
    )


async def wait_for_shim_line(dut, expected_line: int, max_cycles: int = 32) -> None:
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        if (
            int(dut.shim_l1i_valid.value) == 1
            and int(dut.shim_l1i_paddr_line.value) == expected_line
        ):
            return
    raise AssertionError(f"shim did not present expected line 0x{expected_line:x}")


async def assert_no_prefetch_miss_to_line(dut, stale_line: int, max_cycles: int = 32) -> None:
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(dut.miss_valid.value) == 1 and int(dut.miss_is_prefetch.value) == 1:
            observed_line = int(dut.miss_paddr_line.value)
            assert observed_line != stale_line, (
                f"stale queued segment escaped as an L1I prefetch miss: 0x{observed_line:x}"
            )
        assert not (
            int(dut.shim_l1i_valid.value) == 1 and int(dut.shim_l1i_paddr_line.value) == stale_line
        ), f"stale queued segment remained visible at shim: 0x{stale_line:x}"


@cocotb.test()
async def trained_taken_target_prefetch_fills_l1i_and_hits_on_demand(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    pc = 0x8000_2000
    target = 0x8000_4000
    target_line = target & ~0x3F

    await pulse_lookup(dut, pc)
    await pulse_resolve(dut, pc, target, kind=BR_CALL, taken=True, misp=True)

    await pulse_lookup(dut, pc)
    assert int(dut.pred_valid.value) == 1
    assert int(dut.pred_from_ftb.value) == 1
    assert int(dut.pred_taken.value) == 1
    assert int(dut.pred_target.value) == target

    await pop_until_shim_valid(dut)
    assert int(dut.shim_l1i_branch_target.value) == 1
    assert int(dut.shim_l1i_confidence.value) >= 2
    assert int(dut.shim_l1i_paddr_line.value) == target_line

    await wait_for_high(dut, "fdip_pf_valid", max_cycles=16)
    await serve_refill(dut, expected_prefetch=True)

    for _ in range(3):
        await RisingEdge(dut.clk)

    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = target
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0

    await wait_for_demand_prefetch_hit(dut)


@cocotb.test()
async def two_segment_ftq_entry_serializes_l1i_prefetches_in_order(dut):
    """A same-block not-taken guard followed by a taken branch must produce
    both segment prefetches without widening the L1I request interface."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fdip_bundle_enable.value = 0

    block_pc = 0x8000_5C00
    guard_pc = block_pc + 0x04
    redirect_pc = block_pc + 0x18
    guard_target = block_pc + 0x200
    redirect_target = block_pc + 0x300

    for _ in range(8):
        await pulse_resolve(dut, guard_pc, guard_target, kind=BR_COND, taken=False, misp=False)
        await pulse_resolve(dut, redirect_pc, redirect_target, kind=BR_COND, taken=True, misp=False)

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_valid.value) == 1
    assert int(dut.pred_taken.value) == 1
    assert int(dut.pred_target.value) == redirect_target

    requests = await collect_shim_requests(dut, 2)
    assert requests[0] == ((guard_pc + 4) & ~0x3F, 0, 4)
    assert requests[1] == (redirect_target & ~0x3F, 1, 4)


@cocotb.test()
async def two_segment_ftq_entry_exposes_wide_l1i_bundle(dut):
    """The downstream FDIP receiver consumes both non-contiguous fragments in
    one cycle and drains them to L1I in program order."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    block_pc = 0x8000_7C00
    guard_pc = block_pc + 0x04
    redirect_pc = block_pc + 0x18
    guard_target = block_pc + 0x240
    redirect_target = block_pc + 0x380

    for _ in range(8):
        await pulse_resolve(dut, guard_pc, guard_target, kind=BR_COND, taken=False, misp=False)
        await pulse_resolve(dut, redirect_pc, redirect_target, kind=BR_COND, taken=True, misp=False)

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_valid.value) == 1
    assert int(dut.pred_taken.value) == 1
    assert int(dut.pred_target.value) == redirect_target

    await wait_for_wide_shim_valid(dut, 0b11)
    assert int(dut.shim_l1i_paddr_line_vec[0].value) == ((guard_pc + 4) & ~0x3F)
    assert int(dut.shim_l1i_branch_target_vec[0].value) == 0
    assert int(dut.shim_l1i_confidence_vec[0].value) == 4
    assert int(dut.shim_l1i_paddr_line_vec[1].value) == (redirect_target & ~0x3F)
    assert int(dut.shim_l1i_branch_target_vec[1].value) == 1
    assert int(dut.shim_l1i_confidence_vec[1].value) == 4
    assert int(dut.fdip_ftq_ready_vec.value) == 0b11

    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    assert int(dut.shim_l1i_valid_vec.value) == 0
    await serve_refill(dut, expected_prefetch=True, expected_line=((guard_pc + 4) & ~0x3F))
    await serve_refill(dut, expected_prefetch=True, expected_line=(redirect_target & ~0x3F))


@cocotb.test()
async def target_block_two_ahead_fetch_stream_exposes_lane_one(dut):
    """Target-block lane 1 is externally visible as fetch-control metadata.

    The companion demand test proves scalarized consumption; this test locks
    the raw metadata contract so the two-ahead lane is not only an internal BPU
    redirect bit.
    """

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    block_pc = 0x8001_2000
    first_target_block = 0x8001_4000
    final_target = 0x8001_8000

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_valid.value) == 1
    assert int(dut.pred_target.value) == first_target_block
    assert int(dut.pred_redirect_valid.value) == 0b11
    assert int(dut.pred_redirect_pc[0].value) == first_target_block
    assert int(dut.pred_redirect_pc[1].value) == final_target

    await wait_for_fetch_stream_valid(dut, 0b11)
    assert int(dut.fetch_stream_pc[0].value) == block_pc
    assert int(dut.fetch_stream_target_pc[0].value) == first_target_block
    assert int(dut.fetch_stream_taken[0].value) == 1
    assert int(dut.fetch_stream_kind[0].value) == BR_DIRECT
    assert int(dut.fetch_stream_pc[1].value) == first_target_block
    assert int(dut.fetch_stream_target_pc[1].value) == final_target
    assert int(dut.fetch_stream_taken[1].value) == 1


@cocotb.test()
async def target_block_two_ahead_fetch_stream_drives_l1i_demand_in_order(dut):
    """Target-block lane 1 becomes real L1I demand traffic."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fetch_demand_enable.value = 1
    dut.fdip_bundle_enable.value = 0
    dut.miss_ready_lane1.value = 0

    block_pc = 0x8002_2000
    first_target_block = 0x8002_4000
    final_target = 0x8002_8000

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_redirect_valid.value) == 0b11

    await drive_fetch_stream_into_demand_queue(dut, 0b11)
    assert int(dut.fetch_demand_overflow.value) == 0
    assert int(dut.fetch_demand_valid.value) == 1
    assert int(dut.fetch_demand_paddr.value) == first_target_block

    await serve_refill(dut, expected_prefetch=False, expected_line=(first_target_block & ~0x3F))
    await wait_for_low(dut, "miss_valid")
    assert int(dut.miss_valid_lane1.value) == 1
    assert int(dut.miss_is_prefetch_lane1.value) == 0
    assert int(dut.miss_paddr_line_lane1.value) == (final_target & ~0x3F)
    await serve_refill_lane1_after_asserted(dut)


@cocotb.test()
async def target_block_two_ahead_fetch_stream_accepts_cold_lane_one_miss(dut):
    """Cold target-block lane 1 issues on the independent lane-1 miss port."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fetch_demand_enable.value = 1
    dut.miss_ready.value = 0
    dut.miss_ready_lane1.value = 0

    block_pc = 0x8003_A000
    first_target_block = 0x8003_C000
    final_target = 0x8003_E000

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_redirect_valid.value) == 0b11

    await drive_fetch_stream_until_wide_demand_accept(dut, 0b11)

    saw_scalar_miss = False
    saw_lane1_miss = False
    for _ in range(24):
        await RisingEdge(dut.clk)
        saw_scalar_miss |= int(dut.miss_valid.value) == 1
        saw_lane1_miss |= int(dut.miss_valid_lane1.value) == 1
        if saw_scalar_miss and saw_lane1_miss:
            break
    assert saw_scalar_miss, "scalar target-block lane did not issue an L1I miss"
    assert saw_lane1_miss, "cold lane-1 target did not issue a lane-1 L1I miss"
    assert int(dut.miss_paddr_line.value) == (first_target_block & ~0x3F)
    assert int(dut.miss_is_prefetch.value) == 0
    assert int(dut.miss_paddr_line_lane1.value) == (final_target & ~0x3F)
    assert int(dut.miss_is_prefetch_lane1.value) == 0

    await serve_refill_after_asserted(dut)
    await serve_refill_lane1_after_asserted(dut)

    for _ in range(12):
        await RisingEdge(dut.clk)
        if int(dut.ifu_resp_valid_lane1.value) == 1:
            assert int(dut.ifu_resp_paddr_eq_req_lane1.value) == 1
            return
    raise AssertionError("cold lane-1 demand miss did not refill on the lane-1 response port")


@cocotb.test()
async def target_block_two_ahead_fetch_stream_uses_wide_l1i_hit_lane(dut):
    """Hot target-block lanes can issue to L1I demand in the same cycle."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fetch_demand_enable.value = 1

    block_pc = 0x8003_2000
    first_target_block = 0x8003_4000
    final_target = 0x8003_8000

    await fill_l1i_demand_line(dut, first_target_block)
    await fill_l1i_demand_line(dut, final_target)

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_redirect_valid.value) == 0b11

    await drive_fetch_stream_until_wide_demand_accept(dut, 0b11)

    saw_lane0_resp = False
    saw_lane1_resp = False
    for _ in range(12):
        await RisingEdge(dut.clk)
        saw_lane0_resp |= int(dut.ifu_resp_valid.value) == 1
        saw_lane1_resp |= int(dut.ifu_resp_valid_lane1.value) == 1
        if saw_lane0_resp and saw_lane1_resp:
            assert int(dut.ifu_resp_paddr_eq_req.value) == 1
            assert int(dut.ifu_resp_paddr_eq_req_lane1.value) == 1
            return

    raise AssertionError(
        "target-block stream did not use the wide L1I hit lane "
        f"(lane0={saw_lane0_resp}, lane1={saw_lane1_resp})"
    )


@cocotb.test()
async def target_block_two_ahead_fetch_stream_flush_drops_lane_one(dut):
    """A redirect flush must clear a queued target-block lane-1 sideband."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    block_pc = 0x8001_A000
    first_target_block = 0x8001_C000
    final_target = 0x8001_E000

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_redirect_valid.value) == 0b11

    await pulse_resolve(dut, block_pc, block_pc + 0x40, kind=BR_DIRECT, taken=True, misp=True)

    dut.fetch_pop.value = 1
    try:
        for _ in range(8):
            await RisingEdge(dut.clk)
            assert (int(dut.fetch_stream_valid.value) & 0b10) == 0
            assert int(dut.fetch_stream_target_pc[1].value) != final_target
    finally:
        dut.fetch_pop.value = 0


@cocotb.test()
async def target_block_two_ahead_fetch_demand_flush_drops_queued_lane_one(dut):
    """A redirect flush must also purge queued fetch-stream demand requests."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fetch_demand_enable.value = 1
    dut.miss_ready.value = 0

    block_pc = 0x8002_A000
    first_target_block = 0x8002_C000
    final_target = 0x8002_E000
    final_line = final_target & ~0x3F

    await pulse_resolve(dut, block_pc, first_target_block, kind=BR_DIRECT, taken=True, misp=False)
    await pulse_resolve(
        dut, first_target_block, final_target, kind=BR_DIRECT, taken=True, misp=False
    )

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_redirect_valid.value) == 0b11
    await drive_fetch_stream_into_demand_queue(dut, 0b11)
    assert int(dut.fetch_demand_valid.value) == 1

    await pulse_resolve(dut, block_pc, block_pc + 0x40, kind=BR_DIRECT, taken=True, misp=True)
    await RisingEdge(dut.clk)
    assert int(dut.fetch_demand_valid.value) == 0
    assert int(dut.fetch_demand_occupancy.value) == 0

    dut.miss_ready.value = 1
    for _ in range(16):
        await RisingEdge(dut.clk)
        assert not (
            int(dut.miss_valid.value) == 1 and int(dut.miss_paddr_line.value) == final_line
        ), f"flushed target-block lane escaped as demand miss: 0x{final_line:x}"


@cocotb.test()
async def fetch_stream_demand_backpressures_ftq_pop_without_overflow(dut):
    """A full fetch-demand queue must stall the FTQ pop instead of dropping
    target-block lanes."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fetch_demand_enable.value = 1
    dut.fdip_bundle_enable.value = 0
    dut.miss_ready.value = 0

    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = 0x8004_F000
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for_high(dut, "miss_valid", max_cycles=32)

    blocks = [
        (0x8004_0000, 0x8004_2000, 0x8004_4000),
        (0x8004_0080, 0x8004_6000, 0x8004_8000),
        (0x8004_0100, 0x8004_A000, 0x8004_C000),
    ]

    for block_pc, first_target, final_target in blocks:
        await pulse_resolve(dut, block_pc, first_target, kind=BR_DIRECT, taken=True, misp=False)
        await pulse_resolve(dut, first_target, final_target, kind=BR_DIRECT, taken=True, misp=False)

    for block_pc, _, _ in blocks[:2]:
        await pulse_lookup(dut, block_pc)
        await drive_fetch_stream_into_demand_queue(dut, 0b11)
        assert int(dut.fetch_demand_overflow.value) == 0

    assert int(dut.fetch_demand_valid.value) == 1
    assert int(dut.fetch_demand_valid_lane1.value) == 1
    assert int(dut.fetch_demand_paddr.value) == blocks[0][1]
    assert int(dut.fetch_demand_paddr_lane1.value) == blocks[0][2]
    assert int(dut.fetch_demand_ftq_idx.value) == int(dut.fetch_demand_ftq_idx_lane1.value)
    assert int(dut.fetch_demand_segment_idx.value) == 0
    assert int(dut.fetch_demand_segment_idx_lane1.value) == 1
    assert int(dut.fetch_demand_kind.value) == BR_DIRECT
    assert int(dut.fetch_demand_kind_lane1.value) == BR_DIRECT

    max_occupancy = int(dut.fetch_demand_occupancy.value)
    for _ in range(8):
        await RisingEdge(dut.clk)
        max_occupancy = max(max_occupancy, int(dut.fetch_demand_occupancy.value))
        assert int(dut.fetch_demand_overflow.value) == 0
        if max_occupancy >= 3:
            break
    else:
        raise AssertionError(
            f"fetch demand queue did not build backpressure (max_occupancy={max_occupancy})"
        )

    await pulse_lookup(dut, blocks[2][0])

    dut.fetch_pop.value = 1
    saw_stalled_head = False
    try:
        for _ in range(16):
            await RisingEdge(dut.clk)
            assert int(dut.fetch_demand_overflow.value) == 0
            assert int(dut.fetch_demand_occupancy.value) <= 4
            if int(dut.fetch_valid.value) == 1 and int(dut.fetch_start_pc.value) == blocks[2][0]:
                assert int(dut.fetch_stream_valid.value) == 0b11
                assert int(dut.fetch_stream_ready.value) == 0
                saw_stalled_head = True
        assert saw_stalled_head, "third target-block fetch did not remain stalled at FTQ head"
    finally:
        dut.fetch_pop.value = 0


@cocotb.test()
async def two_segment_ftq_prefetch_flush_drops_queued_second_segment(dut):
    """A redirect while segment 1 is queued must not let it escape to L1I."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fdip_bundle_enable.value = 0

    block_pc = 0x8000_9C00
    guard_pc = block_pc + 0x04
    redirect_pc = block_pc + 0x18
    guard_target = block_pc + 0x200
    redirect_target = block_pc + 0x300
    fallthrough_line = (guard_pc + 4) & ~0x3F
    redirected_line = redirect_target & ~0x3F

    for _ in range(8):
        await pulse_resolve(dut, guard_pc, guard_target, kind=BR_COND, taken=False, misp=False)
        await pulse_resolve(dut, redirect_pc, redirect_target, kind=BR_COND, taken=True, misp=False)

    dut.miss_ready.value = 0
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = 0x8000_C000
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for_high(dut, "miss_valid", max_cycles=32)

    await pulse_lookup(dut, block_pc)
    assert int(dut.pred_valid.value) == 1
    assert int(dut.pred_taken.value) == 1
    assert int(dut.pred_target.value) == redirect_target

    dut.fetch_pop.value = 1
    await wait_for_shim_line(dut, fallthrough_line)
    dut.fetch_pop.value = 0

    await wait_for_shim_line(dut, redirected_line)
    assert int(dut.fdip_ftq_ready.value) == 0

    await pulse_resolve(
        dut,
        redirect_pc,
        redirect_target + 0x400,
        kind=BR_COND,
        taken=True,
        misp=True,
    )
    assert int(dut.shim_l1i_valid.value) == 0

    dut.miss_ready.value = 1
    await serve_refill(dut, expected_prefetch=False)
    await assert_no_prefetch_miss_to_line(dut, redirected_line)


@cocotb.test()
async def fdip_holds_l1i_prefetch_under_l1i_backpressure(dut):
    """Prove local FDIP->L1I ready/valid retention.

    This covers the downstream FDIP/L1I ready path; bpu_top FTQ-full
    backpressure is covered in test_bpu_top.
    """

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fdip_bundle_enable.value = 0

    pc = 0x8000_6000
    target = 0x8000_8000

    await pulse_lookup(dut, pc)
    await pulse_resolve(dut, pc, target, kind=BR_CALL, taken=True, misp=True)

    dut.miss_ready.value = 0
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = 0x8000_A000
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for_high(dut, "miss_valid", max_cycles=32)

    await pulse_lookup(dut, pc)
    await pop_until_shim_valid(dut)
    await wait_for_high(dut, "fdip_pf_valid", max_cycles=16)

    observed_not_ready = False
    for _ in range(8):
        await RisingEdge(dut.clk)
        observed_not_ready |= int(dut.l1i_ftq_ready.value) == 0
        assert int(dut.fdip_pf_valid.value) == 1
        assert int(dut.fdip_ftq_ready.value) == 0

    assert observed_not_ready, "test did not create L1I prefetch backpressure"
    dut.miss_ready.value = 1
    await serve_refill(dut, expected_prefetch=False)
    await wait_for_high(dut, "miss_valid", max_cycles=80)
    assert int(dut.miss_is_prefetch.value) == 1


@cocotb.test()
async def fdip_queue_keeps_younger_ftq_prefetch_under_backpressure(dut):
    """A younger FTQ pop must survive while an older prefetch is blocked in
    FDIP/L1I, then drain in order after the miss path recovers."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    dut.fdip_bundle_enable.value = 0

    pc0 = 0x8000_D000
    target0 = 0x8000_E000
    pc1 = 0x8000_D040
    target1 = 0x8000_F000
    target0_line = target0 & ~0x3F
    target1_line = target1 & ~0x3F

    await pulse_lookup(dut, pc0)
    await pulse_resolve(dut, pc0, target0, kind=BR_CALL, taken=True, misp=True)
    await pulse_lookup(dut, pc1)
    await pulse_resolve(dut, pc1, target1, kind=BR_CALL, taken=True, misp=True)

    dut.miss_ready.value = 0
    dut.ifu_req_valid.value = 1
    dut.ifu_req_paddr.value = 0x8001_1000
    await RisingEdge(dut.clk)
    dut.ifu_req_valid.value = 0
    await wait_for_high(dut, "miss_valid", max_cycles=32)

    await pulse_lookup(dut, pc0)
    await pop_until_shim_valid(dut)
    assert int(dut.shim_l1i_paddr_line.value) == target0_line
    await wait_for_high(dut, "fdip_pf_valid", max_cycles=16)

    for _ in range(4):
        await RisingEdge(dut.clk)
        assert int(dut.fdip_ftq_ready.value) == 0

    await pulse_lookup(dut, pc1)
    dut.fetch_pop.value = 1
    await wait_for_shim_line(dut, target1_line)
    dut.fetch_pop.value = 0
    assert int(dut.fdip_ftq_ready.value) == 0

    dut.miss_ready.value = 1
    await serve_refill(dut, expected_prefetch=False, expected_line=0x8001_1000)
    await serve_refill(dut, expected_prefetch=True, expected_line=target0_line)
    await serve_refill(dut, expected_prefetch=True, expected_line=target1_line)


@cocotb.test()
async def ftq_full_suppresses_bpu_prediction_until_fetch_drains(dut):
    """The integrated frontend exposes FTQ-full pressure and suppresses new
    predictions until fetch drains an entry."""

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    base = 0x8001_0000
    for i in range(80):
        await pulse_lookup(dut, base + i * 0x20)

    full_seen = False
    for _ in range(8):
        await RisingEdge(dut.clk)
        full_seen |= ((int(dut.bpu_pmu_strb.value) >> PMU_FTQ_FULL) & 0x1) == 1

    assert full_seen, "FTQ-full PMU did not pulse after overfilling without fetch pops"
    assert int(dut.pred_valid.value) == 0
