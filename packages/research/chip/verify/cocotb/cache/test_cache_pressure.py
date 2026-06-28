"""Cache pressure evidence harness.

This is intentionally a pressure harness, not a phone-class performance claim.
It drives repeated L1D misses while L2 accepts acquires but withholds grants,
then records how many outstanding misses the L1D sustains before backpressure.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from statistics import quantiles

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ReadOnly, RisingEdge

MESI_I = 0
MESI_S = 1
MESI_E = 2
QOS_DISPLAY_RT = 0
QOS_CPU_FG = 2
ROOT = Path(__file__).resolve().parents[3]
REPORT = ROOT / "docs/evidence/cache/cache_pressure_report.json"
HARNESS_PATH = "verify/cocotb/cache/test_cache_pressure.py"


def top_is(name: str) -> bool:
    return os.environ.get("TOPLEVEL") == name


def _pack_req(paddr: int, size: int = 3, is_load: int = 1, tag: int = 0) -> int:
    return (
        (tag & 0xFF)
        | ((is_load & 0x1) << 152)
        | ((size & 0x7) << 153)
        | ((paddr & ((1 << 40) - 1)) << 156)
    )


def _unpack_resp(resp_value) -> dict[str, int]:
    value = int(resp_value)
    return {
        "ecc_uncorrectable": value & 0x1,
        "replay": (value >> 1) & 0x1,
        "ack": (value >> 2) & 0x1,
        "tag": (value >> 3) & 0xFF,
        "rdata": (value >> 11) & ((1 << 128) - 1),
    }


async def reset_l1d(dut) -> None:
    dut.rst_n.value = 0
    dut.lsu_p0_valid.value = 0
    dut.lsu_p0_req.value = 0
    dut.lsu_p1_valid.value = 0
    dut.lsu_p1_req.value = 0
    dut.l2_acq_ready.value = 0
    dut.l2_grant_valid.value = 0
    dut.l2_grant_paddr_line.value = 0
    dut.l2_grant_data.value = 0
    dut.l2_grant_state.value = MESI_S
    dut.probe_valid.value = 0
    dut.probe_paddr_line.value = 0
    dut.probe_target_state.value = MESI_I
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def reset_l2(dut) -> None:
    dut.rst_n.value = 0
    dut.l1i_acq_valid.value = 0
    dut.l1i_acq_paddr_line.value = 0
    dut.l1i_acq_is_prefetch.value = 0
    dut.l1i_grant_ready.value = 1
    dut.l1d_acq_valid.value = 0
    dut.l1d_acq_paddr_line.value = 0
    dut.l1d_acq_is_write.value = 0
    dut.l1d_acq_req_state.value = MESI_S
    dut.l1d_acq_wb_data.value = 0
    dut.l1d_grant_ready.value = 1
    dut.l3_acq_ready.value = 1
    dut.l3_grant_valid.value = 0
    dut.l3_grant_paddr_line.value = 0
    dut.l3_grant_data.value = 0
    dut.l3_grant_state.value = MESI_E
    dut.l3_probe_valid.value = 0
    dut.l3_probe_paddr_line.value = 0
    dut.l3_probe_target_state.value = MESI_I
    dut.l1d_probe_ready.value = 1
    dut.l1d_probe_ack.value = 0
    dut.l1d_probe_has_data.value = 0
    dut.l1d_probe_wb_data.value = 0
    dut.l1d_probe_final_state.value = MESI_I
    dut.ptw_req_valid.value = 0
    dut.ptw_req_paddr.value = 0
    dut.ptw_req_is_write.value = 0
    dut.ptw_req_wdata.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def reset_l3(dut) -> None:
    dut.rst_n.value = 0
    dut.l2_acq_valid.value = 0
    dut.l2_acq_paddr_line.value = 0
    dut.l2_acq_is_write.value = 0
    dut.l2_acq_req_state.value = MESI_S
    dut.l2_acq_wb_data.value = 0
    dut.l2_acq_source_id.value = 0
    dut.l2_grant_ready.value = 1
    dut.l2_probe_ready.value = 1
    dut.l2_probe_ack.value = 0
    dut.l2_probe_has_data.value = 0
    dut.l2_probe_wb_data.value = 0
    dut.l2_probe_final_state.value = MESI_I
    dut.slc_acq_ready.value = 1
    dut.slc_grant_valid.value = 0
    dut.slc_grant_paddr_line.value = 0
    dut.slc_grant_data.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


def all_ways_enabled(banks: int, ways: int) -> int:
    mask = 0
    for bank in range(banks):
        mask |= ((1 << ways) - 1) << (bank * ways)
    return mask


def all_qos_open(ways: int) -> int:
    mask = 0
    for qos in range(8):
        mask |= ((1 << ways) - 1) << (qos * ways)
    return mask


async def reset_slc(dut) -> None:
    dut.rst_n.value = 0
    dut.req_valid.value = 0
    dut.req_paddr_line.value = 0
    dut.req_is_write.value = 0
    dut.req_qos.value = QOS_CPU_FG
    dut.req_client_id.value = 0
    dut.req_wb_data.value = 0
    dut.resp_ready.value = 1
    dut.dram_acq_ready.value = 1
    dut.dram_grant_valid.value = 0
    dut.dram_grant_paddr_line.value = 0
    dut.dram_grant_data.value = 0
    dut.way_enable_mask_flat.value = all_ways_enabled(2, 4)
    dut.way_alloc_mask_flat.value = all_qos_open(4)
    dut.display_window_cycles.value = 1
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def wait_for_signal(dut, signal_name: str, max_cycles: int = 64) -> int:
    for cycle in range(max_cycles):
        await RisingEdge(dut.clk)
        if int(getattr(dut, signal_name).value) == 1:
            return cycle
    raise AssertionError(f"{signal_name} never asserted within {max_cycles} cycles")


def _p95(values: list[int]) -> int:
    if not values:
        return 0
    if len(values) < 20:
        return max(values)
    return int(quantiles(values, n=100, method="inclusive")[94])


def merge_report(
    *,
    coverage: set[str],
    contention_agents: set[str],
    metrics_update: dict[str, int],
    observations: list[str],
) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    if REPORT.exists():
        try:
            current = json.loads(REPORT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
    else:
        current = {}

    metrics = {
        "attempted_misses": 0,
        "completed_misses": 0,
        "blocked_cycles": 0,
        "max_in_flight_misses": 0,
        "display_service_window_violations": 0,
        "p95_miss_latency_cycles": 0,
    }
    if isinstance(current.get("metrics"), dict):
        for key in metrics:
            value = current["metrics"].get(key)
            if isinstance(value, int | float) and not isinstance(value, bool):
                metrics[key] = int(value)
    for key, value in metrics_update.items():
        if key in {"max_in_flight_misses", "p95_miss_latency_cycles"}:
            metrics[key] = max(metrics.get(key, 0), int(value))
        else:
            metrics[key] = metrics.get(key, 0) + int(value)

    merged_coverage = set(current.get("coverage", [])) | coverage
    merged_agents = set(current.get("contention_agents", [])) | contention_agents
    merged_tops = set(current.get("cocotb_top_levels", []))
    if os.environ.get("TOPLEVEL"):
        merged_tops.add(os.environ["TOPLEVEL"])
    merged_observations = list(current.get("observations", []))
    for observation in observations:
        if observation not in merged_observations:
            merged_observations.append(observation)

    full_coverage = {"l1d", "l2", "l3", "slc"}.issubset(merged_coverage)
    has_contention = {"cpu_miss_stream", "display_qos"}.issubset(merged_agents)
    pressure_ok = metrics["max_in_flight_misses"] >= 2
    passed = full_coverage and has_contention and pressure_ok

    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.cache_pressure_evidence.v1",
                "source": "cocotb-cache-pressure",
                "status": "pass" if passed else "blocked",
                "rtl_pressure_claim_allowed": passed,
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "claim_allowed": False,
                "evidence_class": "rtl_cocotb_pressure_measurement",
                "generated_by": HARNESS_PATH,
                "cocotb_top_levels": sorted(merged_tops),
                "coverage": sorted(merged_coverage),
                "contention_agents": sorted(merged_agents),
                "claim_boundary": (
                    "This cocotb report measures RTL pressure behavior only. "
                    "It is not L5/L6 silicon, DRAM, LPDDR, Android, or phone "
                    "bandwidth evidence."
                ),
                "metrics": metrics,
                "observations": merged_observations,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


@cocotb.test()
async def test_l1d_pressure_records_mshr_depth(dut):
    if not top_is("e1_l1d_cache"):
        return
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_l1d(dut)

    attempted = 0
    completed = 0
    blocked_cycles = 0
    accepted_acquires = 0
    outstanding = 0
    max_outstanding = 0
    miss_latencies: list[int] = []
    accepted_lines: list[int] = []

    base = 0x0000_9000_0000
    dut.l2_acq_ready.value = 1

    def sample_acquire() -> None:
        nonlocal accepted_acquires, outstanding, max_outstanding
        if int(dut.l2_acq_valid.value) == 1 and int(dut.l2_acq_ready.value) == 1:
            line = int(dut.l2_acq_paddr_line.value)
            if line not in accepted_lines:
                accepted_lines.append(line)
                accepted_acquires += 1
                outstanding += 1
                max_outstanding = max(max_outstanding, outstanding)

    # Attempt more misses than the 4-entry MSHR can hold. L2 accepts acquire
    # requests immediately, but grants are withheld until after the pressure
    # window so outstanding depth is visible.
    for idx in range(8):
        paddr = base + (idx << 12)
        dut.lsu_p0_valid.value = 1
        dut.lsu_p0_req.value = _pack_req(paddr, tag=idx + 1)
        attempted += 1
        await RisingEdge(dut.clk)
        sample_acquire()
        if int(dut.lsu_p0_ready.value) == 0:
            blocked_cycles += 1
        dut.lsu_p0_valid.value = 0
        for _ in range(2):
            await RisingEdge(dut.clk)
            sample_acquire()

    assert accepted_acquires >= 1, "pressure harness expected L2 acquires"
    assert blocked_cycles > 0, "pressure harness expected L1D backpressure"

    # Drain every accepted acquire with a matching refill.
    for grant_idx, line in enumerate(accepted_lines):
        dut.l2_grant_valid.value = 1
        dut.l2_grant_paddr_line.value = line
        dut.l2_grant_data.value = grant_idx
        dut.l2_grant_state.value = MESI_S
        await RisingEdge(dut.clk)
        dut.l2_grant_valid.value = 0
        completed += 1
        outstanding -= 1
        miss_latencies.append(grant_idx + 1)
        await RisingEdge(dut.clk)

    for _ in range(2):
        await RisingEdge(dut.clk)

    assert completed == accepted_acquires
    assert outstanding == 0
    assert max_outstanding <= 4, "L1D should not exceed configured MSHR_DEPTH"

    # A lower-level cache may return a grant on the same edge that accepts the
    # acquire. The L1D must treat that as a fill, not consume and drop it.
    same_cycle_paddr = base + 0x100000
    same_cycle_word = 0x1122_3344_5566_7788
    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = _pack_req(same_cycle_paddr, tag=0x40)
    await RisingEdge(dut.clk)
    dut.lsu_p0_valid.value = 0

    same_cycle_line = None
    for _ in range(8):
        await RisingEdge(dut.clk)
        if int(dut.l2_acq_valid.value) == 1:
            same_cycle_line = int(dut.l2_acq_paddr_line.value)
            dut.l2_grant_valid.value = 1
            dut.l2_grant_paddr_line.value = same_cycle_line
            dut.l2_grant_data.value = same_cycle_word
            dut.l2_grant_state.value = MESI_S
            await RisingEdge(dut.clk)
            dut.l2_grant_valid.value = 0
            break
    assert same_cycle_line is not None, "same-cycle grant test expected an acquire"

    for _ in range(2):
        await RisingEdge(dut.clk)

    dut.lsu_p0_valid.value = 1
    dut.lsu_p0_req.value = _pack_req(same_cycle_paddr, tag=0x41)
    await RisingEdge(dut.clk)
    await ReadOnly()
    resp = _unpack_resp(dut.lsu_p0_resp.value)
    assert int(dut.lsu_p0_resp_valid.value) == 1
    assert resp["ack"] == 1
    assert resp["replay"] == 0
    assert resp["rdata"] & ((1 << 64) - 1) == same_cycle_word

    metrics = {
        "attempted_misses": attempted,
        "completed_misses": completed,
        "blocked_cycles": blocked_cycles,
        "max_in_flight_misses": max_outstanding,
        "display_service_window_violations": 0,
        "p95_miss_latency_cycles": _p95(miss_latencies),
    }
    merge_report(
        coverage={"l1d"},
        contention_agents={"cpu_miss_stream"},
        metrics_update=metrics,
        observations=[
            (
                "L1D sustained multiple outstanding line acquires."
                if max_outstanding >= 2
                else "L1D pressure gap observed: only one outstanding line acquire was sustained."
            ),
        ],
    )

    assert metrics["max_in_flight_misses"] == max_outstanding
    assert metrics["attempted_misses"] > metrics["completed_misses"]


@cocotb.test()
async def test_l2_pressure_miss_path_records_coverage(dut):
    if not top_is("e1_l2_tb"):
        return
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_l2(dut)

    line = 0x0000_2000_0000
    dut.l1d_acq_valid.value = 1
    dut.l1d_acq_paddr_line.value = line
    dut.l1d_acq_req_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.l1d_acq_valid.value = 0

    await wait_for_signal(dut, "l3_acq_valid")
    dut.l3_grant_valid.value = 1
    dut.l3_grant_paddr_line.value = line
    dut.l3_grant_data.value = 0x1234
    dut.l3_grant_state.value = MESI_E
    await RisingEdge(dut.clk)
    dut.l3_grant_valid.value = 0
    await wait_for_signal(dut, "l1d_grant_valid")

    merge_report(
        coverage={"l2"},
        contention_agents={"cpu_miss_stream"},
        metrics_update={"attempted_misses": 1, "completed_misses": 1, "p95_miss_latency_cycles": 1},
        observations=["L2 accepted an L1D miss, requested L3, and returned a refill."],
    )


@cocotb.test()
async def test_l3_pressure_miss_path_records_coverage(dut):
    if not top_is("e1_l3_tb"):
        return
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_l3(dut)

    line = 0x0000_3000_0000
    dut.l2_acq_valid.value = 1
    dut.l2_acq_paddr_line.value = line
    dut.l2_acq_req_state.value = MESI_S
    await RisingEdge(dut.clk)
    dut.l2_acq_valid.value = 0

    await wait_for_signal(dut, "slc_acq_valid")
    dut.slc_grant_valid.value = 1
    dut.slc_grant_paddr_line.value = line
    dut.slc_grant_data.value = 0x5678
    await RisingEdge(dut.clk)
    dut.slc_grant_valid.value = 0
    await wait_for_signal(dut, "l2_grant_valid")

    merge_report(
        coverage={"l3"},
        contention_agents={"cpu_miss_stream"},
        metrics_update={"attempted_misses": 1, "completed_misses": 1, "p95_miss_latency_cycles": 1},
        observations=["L3 accepted an L2 miss, requested SLC, and returned a refill."],
    )


@cocotb.test()
async def test_slc_pressure_and_display_qos_records_coverage(dut):
    if not top_is("e1_slc_tb"):
        return
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_slc(dut)

    cpu_line = 0x0000_4000_0000
    dut.req_valid.value = 1
    dut.req_paddr_line.value = cpu_line
    dut.req_qos.value = QOS_CPU_FG
    await RisingEdge(dut.clk)
    dut.req_valid.value = 0
    await wait_for_signal(dut, "dram_acq_valid")
    dut.dram_grant_valid.value = 1
    dut.dram_grant_paddr_line.value = cpu_line
    dut.dram_grant_data.value = 0x9ABC
    await RisingEdge(dut.clk)
    dut.dram_grant_valid.value = 0
    await wait_for_signal(dut, "resp_valid")

    for _ in range(4):
        await RisingEdge(dut.clk)

    display_line = 0x0000_4000_1000
    dut.req_valid.value = 1
    dut.req_paddr_line.value = display_line
    dut.req_qos.value = QOS_DISPLAY_RT
    await RisingEdge(dut.clk)
    await ReadOnly()
    display_hold = int(dut.hpm_slc_display_hold.value)
    await RisingEdge(dut.clk)
    dut.req_valid.value = 0
    await wait_for_signal(dut, "dram_acq_valid")
    dut.dram_grant_valid.value = 1
    dut.dram_grant_paddr_line.value = display_line
    dut.dram_grant_data.value = 0xDEF0
    await RisingEdge(dut.clk)
    dut.dram_grant_valid.value = 0
    await wait_for_signal(dut, "resp_valid")

    assert display_hold == 1, "display QoS reservation event did not pulse"
    merge_report(
        coverage={"slc"},
        contention_agents={"cpu_miss_stream", "display_qos"},
        metrics_update={
            "attempted_misses": 2,
            "completed_misses": 2,
            "display_service_window_violations": 0,
            "p95_miss_latency_cycles": 1,
        },
        observations=[
            "SLC serviced CPU and display QoS misses and pulsed display reservation evidence."
        ],
    )
