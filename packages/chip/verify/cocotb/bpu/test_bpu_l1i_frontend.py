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

BR_CALL = 2
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
    dut.resolve_tage_provider.value = 0
    dut.resolve_ittage_provider.value = 0
    dut.ifu_req_valid.value = 0
    dut.ifu_req_paddr.value = 0
    dut.ifu_flush.value = 0
    dut.miss_ready.value = 1
    dut.refill_valid.value = 0
    dut.refill_data.value = 0
    dut.refill_beat_idx.value = 0
    dut.refill_last.value = 0
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
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
    dut.resolve_tage_provider.value = 0
    dut.resolve_ittage_provider.value = 0
    await RisingEdge(dut.clk)
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0


async def wait_for_high(dut, signal_name: str, max_cycles: int = 64) -> int:
    for cycle in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal_name).value) == 1:
            return cycle
    raise AssertionError(f"{signal_name} did not assert within {max_cycles} cycles")


async def serve_refill(dut, *, expected_prefetch: bool | None = None) -> None:
    await wait_for_high(dut, "miss_valid", max_cycles=80)
    if expected_prefetch is not None:
        assert int(dut.miss_is_prefetch.value) == int(expected_prefetch)
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


async def pop_until_shim_valid(dut, max_cycles: int = 24) -> None:
    dut.fetch_pop.value = 1
    for _ in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(dut.shim_l1i_valid.value) == 1:
            dut.fetch_pop.value = 0
            return
    dut.fetch_pop.value = 0
    raise AssertionError("BPU fetch pop did not produce a shim L1I request")


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
async def fdip_holds_l1i_prefetch_under_l1i_backpressure(dut):
    """Prove local FDIP->L1I ready/valid retention.

    This covers the downstream FDIP/L1I ready path; bpu_top FTQ-full
    backpressure is covered in test_bpu_top.
    """

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

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
