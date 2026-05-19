"""End-to-end MPKI evaluation for ``bpu_top`` driven by cocotb.

For each of the 8 canonical synthetic workloads exposed by
``benchmarks.cpu.branch.traces.SYNTHETIC_GENERATORS`` this module:

  * Resets the BPU and the FTQ.
  * Replays every branch event from the generator: predict on a PC, then
    observe the BPU prediction and resolve with the actual outcome,
    setting ``resolve_misp`` based on whether the BPU agreed with the
    actual taken/target.
  * Records per-workload PMU counters via the ``csr_*`` read port:
    BR_PRED, BR_MISP, BR_TAKEN, BR_IND, BR_IND_MISP, BR_RET,
    BR_RET_MISP, RAS_OVERFLOW, FTB_MISS, LOOP_HIT, SC_OVERRIDE,
    UFTB_HIT, TAGE_ALLOC.
  * Emits a single JSON file with ``schema=eliza.bpu_mpki.v1`` describing
    every workload, the PMU snapshot, MPKI, branch throughput, and the
    independent misprediction breakdown by branch class.

The JSON path defaults to ``docs/evidence/cpu_ap/mpki_results_synthetic.json``
and may be overridden by the ``ELIZA_BPU_MPKI_JSON`` environment variable so
the ``make mpki-eval`` wrapper can stage the artifact under a build dir
when running interactively.

Synthetic workloads exercise the BPU control paths only. The JSON envelope
records ``trace_class=synthetic_planning_only`` and explicit ``claim_policy``
flags refuse SPEC2017 / Android / V8 claims; the policy is enforced upstream
by ``scripts/check_branch_prediction.py``.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

# Make the in-tree ``benchmarks`` package importable regardless of where cocotb
# launches the simulator from. The cocotb makefile cds into ``verify/cocotb/bpu``
# so we resolve the repo root from this file's location.
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from benchmarks.cpu.branch.bpu_model import (  # noqa: E402
    BR_CALL,
    BR_COND,
    BR_RET,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import SYNTHETIC_GENERATORS  # noqa: E402

# PMU enum (zero-based; matches bpu_pkg::pmu_event_e).
PMU_BR_PRED = 0
PMU_BR_TAKEN = 1
PMU_BR_MISP = 2
PMU_BR_COND = 3
PMU_BR_COND_MISP = 4
PMU_BR_IND = 5
PMU_BR_IND_MISP = 6
PMU_BR_CALL = 7
PMU_BR_RET = 8
PMU_BR_RET_MISP = 9
PMU_RAS_OVERFLOW = 10
PMU_RAS_UNDERFLOW = 11
PMU_FTQ_FULL = 12
PMU_FTQ_EMPTY = 13
PMU_FETCH_BUBBLE = 14
PMU_FTB_MISS = 15
PMU_UFTB_HIT = 16
PMU_TAGE_ALLOC = 17
PMU_LOOP_HIT = 18
PMU_SC_OVERRIDE = 19

# Per-branch instruction estimate. 5 instructions / branch is the same
# assumption used by the model-only harness in benchmarks/cpu/branch/run_mpki.py
# and by the modeled MPKI inputs in simulator-arch-metrics-sota.json.
INSTRUCTIONS_PER_BRANCH = 5

# CBP-5 TAGE-SC-L 64 KB published reference; lifted into the JSON envelope so
# downstream tooling does not have to re-parse the comparison table.
CBP5_TAGE_SC_L_REFERENCE_MPKI = 3.986
TARGET_2028_MPKI = 4.0


async def _reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.fetch_pop.value = 1  # keep the FTQ drained so it never blocks the BPU
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0
    dut.resolve_pc.value = 0
    dut.resolve_target.value = 0
    dut.resolve_taken.value = 0
    dut.resolve_kind.value = 0
    dut.resolve_ftq_idx.value = 0
    dut.csr_re.value = 0
    dut.csr_addr.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _read_counter(dut, addr: int) -> int:
    dut.csr_re.value = 1
    dut.csr_addr.value = addr
    await RisingEdge(dut.clk)
    dut.csr_re.value = 0
    return int(dut.csr_rdata.value)


async def _drive_event(dut, event: BranchEvent) -> bool:
    """Predict on ``event.pc``, observe the BPU prediction, resolve.

    Returns ``True`` iff the BPU mispredicted (per-event ground truth used
    by the harness for an independent misprediction count that complements
    the PMU readout).
    """
    # Drive the prediction request and read the BPU's combinational outputs
    # on the same edge.
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = event.pc
    await RisingEdge(dut.clk)
    pred_valid = int(dut.pred_valid.value) == 1
    pred_taken = int(dut.pred_taken.value) == 1
    pred_target = int(dut.pred_target.value)
    pred_kind = int(dut.pred_kind.value)
    dut.lkp_valid.value = 0

    actual_taken = bool(event.taken)
    actual_target = int(event.target)

    if pred_valid:
        target_check = (not actual_taken) or (pred_target == actual_target)
        kind_check = (pred_kind == event.kind) or (event.kind == BR_COND and pred_kind == 0)
        misp = (
            (pred_taken != actual_taken)
            or (actual_taken and not target_check)
            or (not kind_check and event.kind in (BR_CALL, BR_RET))
        )
    else:
        misp = True

    dut.resolve_valid.value = 1
    dut.resolve_misp.value = 1 if misp else 0
    dut.resolve_pc.value = event.pc
    dut.resolve_target.value = actual_target
    dut.resolve_taken.value = 1 if actual_taken else 0
    dut.resolve_kind.value = event.kind
    dut.resolve_ftq_idx.value = 0
    await RisingEdge(dut.clk)
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0
    return misp


def _diff(after: dict[str, int], before: dict[str, int]) -> dict[str, int]:
    return {k: after[k] - before[k] for k in after}


async def _snapshot_counters(dut) -> dict[str, int]:
    return {
        "br_pred": await _read_counter(dut, PMU_BR_PRED),
        "br_taken": await _read_counter(dut, PMU_BR_TAKEN),
        "br_misp": await _read_counter(dut, PMU_BR_MISP),
        "br_cond": await _read_counter(dut, PMU_BR_COND),
        "br_cond_misp": await _read_counter(dut, PMU_BR_COND_MISP),
        "br_ind": await _read_counter(dut, PMU_BR_IND),
        "br_ind_misp": await _read_counter(dut, PMU_BR_IND_MISP),
        "br_call": await _read_counter(dut, PMU_BR_CALL),
        "br_ret": await _read_counter(dut, PMU_BR_RET),
        "br_ret_misp": await _read_counter(dut, PMU_BR_RET_MISP),
        "ras_overflow": await _read_counter(dut, PMU_RAS_OVERFLOW),
        "ras_underflow": await _read_counter(dut, PMU_RAS_UNDERFLOW),
        "ftb_miss": await _read_counter(dut, PMU_FTB_MISS),
        "uftb_hit": await _read_counter(dut, PMU_UFTB_HIT),
        "tage_alloc": await _read_counter(dut, PMU_TAGE_ALLOC),
        "loop_hit": await _read_counter(dut, PMU_LOOP_HIT),
        "sc_override": await _read_counter(dut, PMU_SC_OVERRIDE),
    }


async def _run_workload(dut, name: str, events: list[BranchEvent]) -> dict:
    """Drive a single workload from a clean reset; return the result dict."""
    await _reset(dut)
    before = await _snapshot_counters(dut)

    misp_total = 0
    misp_ind = 0
    misp_ret = 0
    taken_count = 0
    for event in events:
        misp = await _drive_event(dut, event)
        if event.taken:
            taken_count += 1
        if misp:
            misp_total += 1
            if event.kind == BR_CALL:
                misp_ind += 1
            elif event.kind == BR_RET:
                misp_ret += 1

    # Allow one settle cycle so the PMU strobe path closes its window.
    await RisingEdge(dut.clk)
    after = await _snapshot_counters(dut)
    delta = _diff(after, before)

    branch_count = len(events)
    instruction_count_estimate = branch_count * INSTRUCTIONS_PER_BRANCH
    pmu_misp = delta["br_misp"]
    # Prefer the PMU counter for MPKI: that is the architectural number a
    # silicon performance counter would emit. The harness-side misp count is
    # retained as a cross-check.
    mpki_pmu = (
        (pmu_misp * 1000.0) / instruction_count_estimate if instruction_count_estimate else 0.0
    )
    mpki_harness = (
        (misp_total * 1000.0) / instruction_count_estimate if instruction_count_estimate else 0.0
    )
    taken_throughput = (taken_count / branch_count) if branch_count else 0.0

    return {
        "workload": name,
        "trace_class": "synthetic_planning_only",
        "branch_count": branch_count,
        "instruction_count_estimate": instruction_count_estimate,
        "instructions_per_branch_assumption": INSTRUCTIONS_PER_BRANCH,
        "misprediction_count": int(pmu_misp),
        "misprediction_count_harness_observed": int(misp_total),
        "mpki": round(mpki_pmu, 6),
        "mpki_harness_observed": round(mpki_harness, 6),
        "taken_branch_throughput": round(taken_throughput, 6),
        "ras_misp_count": int(delta["br_ret_misp"]),
        "ras_misp_count_harness_observed": int(misp_ret),
        "indirect_misp_count": int(delta["br_ind_misp"]),
        "indirect_misp_count_harness_observed": int(misp_ind),
        "pmu_counters_delta": delta,
        "cbp5_tage_sc_l_reference_mpki": CBP5_TAGE_SC_L_REFERENCE_MPKI,
        "target_2028_mpki": TARGET_2028_MPKI,
        "gap_to_target_mpki": round(mpki_pmu - TARGET_2028_MPKI, 6),
    }


def _resolve_output_path() -> Path:
    override = os.environ.get("ELIZA_BPU_MPKI_JSON")
    if override:
        return Path(override)
    return _REPO_ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"


@cocotb.test()
async def bpu_mpki_synthetic_8_workload_sweep(dut):
    """Run all 8 canonical synthetic workloads end-to-end through the RTL
    BPU and write ``mpki_results_synthetic.json`` with per-workload MPKI."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    results: dict[str, dict] = {}
    expected = list(SYNTHETIC_GENERATORS.keys())
    assert len(expected) == 8, f"expected exactly 8 workloads, found {expected}"

    for name in expected:
        events = [
            BranchEvent(pc=int(e.pc), target=int(e.target), taken=bool(e.taken), kind=int(e.kind))
            for e in SYNTHETIC_GENERATORS[name]()
        ]
        results[name] = await _run_workload(dut, name, events)

    misp_total = sum(r["misprediction_count"] for r in results.values())
    instructions_total = sum(r["instruction_count_estimate"] for r in results.values())
    aggregate_mpki = (misp_total * 1000.0 / instructions_total) if instructions_total else 0.0

    envelope = {
        "schema": "eliza.bpu_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "cocotb-rtl-bpu_top",
        "rtl_top": "bpu_top",
        "instructions_per_branch_assumption": INSTRUCTIONS_PER_BRANCH,
        "cbp5_tage_sc_l_reference_mpki": CBP5_TAGE_SC_L_REFERENCE_MPKI,
        "target_2028_mpki": TARGET_2028_MPKI,
        "aggregate": {
            "branch_count": sum(r["branch_count"] for r in results.values()),
            "misprediction_count": misp_total,
            "instruction_count_estimate": instructions_total,
            "mpki": round(aggregate_mpki, 6),
        },
        "workloads": results,
        "claim_policy": {
            "synthetic_workloads_are_planning_only": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "cbp5_claim": False,
            "reason": (
                "These workloads are deterministic synthetic generators that "
                "exercise the BPU's control paths. They do not represent "
                "SPEC2017, AOSP, or JavaScript-engine traces. Real-MPKI claims "
                "remain blocked until CBP-5/SPEC/Android traces are ingested "
                "into benchmarks/cpu/branch/. The CBP-5 TAGE-SC-L 64 KB "
                "reference (3.986 MPKI) is included only for table-shape "
                "comparison and is not a measurement of this RTL on those "
                "traces."
            ),
        },
    }

    out_path = _resolve_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")

    dut._log.info(f"bpu_mpki: wrote {out_path}")
    dut._log.info(f"bpu_mpki: aggregate MPKI = {aggregate_mpki:.3f}")
    for name, r in results.items():
        dut._log.info(
            f"bpu_mpki: {name}: branches={r['branch_count']} "
            f"misp={r['misprediction_count']} mpki={r['mpki']:.3f}"
        )
