"""End-to-end MPKI evaluation for ``bpu_top`` driven by cocotb.

For each canonical synthetic workload exposed by
``benchmarks.cpu.branch.traces.SYNTHETIC_GENERATORS`` this module:

  * Resets the BPU and the FTQ.
  * Replays every branch event from the generator: predict on a PC, then
    observe the BPU prediction and resolve with the actual outcome,
    setting ``resolve_misp`` based on whether the BPU agreed with the
    actual taken/target.
  * Records per-workload PMU counters via the ``csr_*`` read port:
    BR_PRED, BR_MISP, BR_TAKEN, BR_IND, BR_IND_MISP, BR_RET,
    BR_RET_MISP, RAS_OVERFLOW, FTB_MISS, LOOP_HIT, SC_OVERRIDE,
    H2P_OVERRIDE, L2_FTB_HIT, L2_FTB_MISS, L2_FTB_LATE_REDIRECT,
    TWO_AHEAD_REDIRECT,
    LOCAL_DIR_OVERRIDE, META_TRAIN, UFTB_HIT, TAGE_ALLOC.
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
from cocotb.triggers import RisingEdge, Timer

# Make the in-tree ``benchmarks`` package importable regardless of where cocotb
# launches the simulator from. The cocotb makefile cds into ``verify/cocotb/bpu``
# so we resolve the repo root from this file's location.
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from benchmarks.cpu.branch.bpu_model import (  # noqa: E402
    BR_CALL,
    BR_COND,
    BR_DIRECT,
    BR_IND,
    BR_RET,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import (  # noqa: E402
    SYNTHETIC_GENERATORS,
    read_cbp5_with_count,
)
from benchmarks.cpu.branch.workload_trace import read_workload_trace  # noqa: E402

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
PMU_H2P_OVERRIDE = 20
PMU_L2_FTB_HIT = 21
PMU_L2_FTB_MISS = 22
PMU_TWO_AHEAD_REDIRECT = 23
PMU_LOCAL_DIR_OVERRIDE = 24
PMU_META_TRAIN = 25
PMU_L2_FTB_LATE_REDIRECT = 26

# Per-branch instruction estimate. 5 instructions / branch is the same
# assumption used by the model-only harness in benchmarks/cpu/branch/run_mpki.py
# and by the modeled MPKI inputs in simulator-arch-metrics-sota.json.
INSTRUCTIONS_PER_BRANCH = 5
FETCH_BLOCK_OFF_W = 5
MAX_BR_PER_BLOCK = 2
VADDR_W = 39
FTQ_IDX_W = 6

# CBP-5 TAGE-SC-L 64 KB published reference; lifted into the JSON envelope so
# downstream tooling does not have to re-parse the comparison table.
CBP5_TAGE_SC_L_REFERENCE_MPKI = 3.986
TARGET_2028_MPKI = 4.0
WORKLOAD_RTL_CLAIM_BOUNDARY = (
    "qemu_rv64_workload evidence is prefix RTL replay coverage for local "
    "duty-cycle traces; it is not SPEC2017, Android, JavaScript-engine, "
    "phone, or release evidence."
)


def _event_context(event: BranchEvent) -> dict[str, int]:
    return {
        "asid": int(getattr(event, "asid", 0)),
        "vmid": int(getattr(event, "vmid", 0)),
        "priv": int(getattr(event, "priv", 0)),
        "secure": int(getattr(event, "secure", 0)),
        "workload_class": int(getattr(event, "workload_class", 0)),
    }


async def _reset(dut):
    dut.rst_n.value = 0
    dut.lkp_valid.value = 0
    dut.lkp_pc.value = 0
    dut.lkp_asid.value = 0
    dut.lkp_vmid.value = 0
    dut.lkp_priv.value = 0
    dut.lkp_secure.value = 0
    dut.lkp_workload_class.value = 0
    dut.fetch_pop.value = 1  # keep the FTQ drained so it never blocks the BPU
    dut.resolve_valid.value = 0
    dut.resolve_misp.value = 0
    dut.resolve_asid.value = 0
    dut.resolve_vmid.value = 0
    dut.resolve_priv.value = 0
    dut.resolve_secure.value = 0
    dut.resolve_workload_class.value = 0
    dut.resolve_pc.value = 0
    dut.resolve_target.value = 0
    dut.resolve_call_return_pc.value = 0
    dut.resolve_taken.value = 0
    dut.resolve_kind.value = 0
    dut.resolve_ftq_idx.value = 0
    dut.resolve_ras_restore_top.value = 0
    dut.predictor_flush_valid.value = 0
    dut.predictor_flush_context_valid.value = 0
    dut.predictor_flush_asid.value = 0
    dut.predictor_flush_vmid.value = 0
    dut.predictor_flush_priv.value = 0
    dut.predictor_flush_secure.value = 0
    dut.predictor_flush_workload_class.value = 0
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


def _signal_int(dut, path: str) -> int | None:
    handle = dut
    try:
        for part in path.split("."):
            handle = getattr(handle, part)
        return int(handle.value)
    except Exception:
        return None


async def _drive_event(
    dut,
    event: BranchEvent,
    *,
    debug_samples: list[dict] | None = None,
    trace_name: str = "",
    sequence: int = 0,
) -> bool:
    """Predict on ``event.pc``, observe the BPU prediction, resolve.

    Returns ``True`` iff the BPU mispredicted (per-event ground truth used
    by the harness for an independent misprediction count that complements
    the PMU readout).
    """
    ctx = _event_context(event)
    # Drive the prediction request and read the BPU outputs on the following
    # edge, matching the rest of the one-event-at-a-time MPKI harness cadence.
    dut.lkp_valid.value = 1
    dut.lkp_pc.value = event.pc
    dut.lkp_asid.value = ctx["asid"]
    dut.lkp_vmid.value = ctx["vmid"]
    dut.lkp_priv.value = ctx["priv"]
    dut.lkp_secure.value = ctx["secure"]
    dut.lkp_workload_class.value = ctx["workload_class"]
    await Timer(1, units="ns")
    pred_valid = int(dut.pred_valid.value) == 1
    pred_taken = int(dut.pred_taken.value) == 1
    pred_target = int(dut.pred_target.value)
    pred_kind = int(dut.pred_kind.value)
    pred_segment_valid = int(dut.pred_segment_valid.value)
    pred_segment_taken = int(dut.pred_segment_taken.value)
    pred_segment_target = int(dut.pred_segment_target_pc.value)
    pred_segment_offset = int(dut.pred_segment_branch_offset.value)
    ftq_push_ptr = _signal_int(dut, "u_bpu.ftq_push_ptr")
    resolve_ftq_idx = (
        int(ftq_push_ptr) & ((1 << FTQ_IDX_W) - 1)
        if pred_valid and ftq_push_ptr is not None
        else 0
    )
    await RisingEdge(dut.clk)
    dut.lkp_valid.value = 0

    actual_taken = bool(event.taken)
    actual_target = int(event.target)
    event_offset = int(event.pc) & ((1 << FETCH_BLOCK_OFF_W) - 1)
    segment_match: tuple[bool, int] | None = None
    for slot in range(MAX_BR_PER_BLOCK):
        if ((pred_segment_valid >> slot) & 0x1) == 0:
            continue
        slot_offset = (pred_segment_offset >> (slot * FETCH_BLOCK_OFF_W)) & (
            (1 << FETCH_BLOCK_OFF_W) - 1
        )
        if slot_offset == event_offset:
            slot_taken = ((pred_segment_taken >> slot) & 0x1) == 1
            slot_target = (pred_segment_target >> (slot * VADDR_W)) & ((1 << VADDR_W) - 1)
            segment_match = (slot_taken, slot_target)
            break

    if pred_valid and segment_match is not None:
        segment_taken, segment_target = segment_match
        target_check = (not actual_taken) or (segment_target == actual_target)
        kind_check = (pred_kind == event.kind) or (event.kind == BR_COND and pred_kind == 0)
        misp = (
            (segment_taken != actual_taken)
            or (actual_taken and not target_check)
            or (not kind_check and event.kind in (BR_CALL, BR_RET, BR_IND, BR_DIRECT))
        )
    elif pred_valid:
        target_check = (not actual_taken) or (pred_target == actual_target)
        kind_check = (pred_kind == event.kind) or (event.kind == BR_COND and pred_kind == 0)
        misp = (
            (pred_taken != actual_taken)
            or (actual_taken and not target_check)
            or (not kind_check and event.kind in (BR_CALL, BR_RET, BR_IND, BR_DIRECT))
        )
    else:
        misp = True

    # call_return_pc carries the architectural fall-through PC of the call
    # so the BPU's RAS pushes the correct return address. Trace readers for
    # real ISA streams set this explicitly (usually pc + 4). Synthetic
    # generators leave it unset and the behavioural model defaults to the
    # fetch-block stride, so mirror that default here for RTL/model parity.
    return_pc = (
        event.call_return_pc
        if event.call_return_pc is not None
        else int(event.pc) + (1 << FETCH_BLOCK_OFF_W)
    )
    prediction_debug = None
    if debug_samples is not None:
        prediction_debug = {
            "trace": trace_name,
            "sequence": sequence,
            "pc": int(event.pc),
            "target": actual_target,
            "taken": actual_taken,
            "kind": int(event.kind),
            "context": ctx,
            "pred_valid": pred_valid,
            "pred_taken": pred_taken,
            "pred_target": pred_target,
            "pred_kind": pred_kind,
            "misp": bool(misp),
            "fetch_valid": _signal_int(dut, "fetch_valid"),
            "fetch_ftq_idx": _signal_int(dut, "fetch_ftq_idx"),
            "fetch_tage_provider": _signal_int(dut, "fetch_tage_provider"),
            "fetch_tage_provider_ctr": _signal_int(dut, "fetch_tage_provider_ctr"),
            "fetch_tage_lowconf": _signal_int(dut, "fetch_tage_lowconf"),
            "fetch_ghist_snapshot": _signal_int(dut, "fetch_ghist_snapshot"),
            "fetch_sc_override": _signal_int(dut, "fetch_sc_override"),
            "fetch_sc_taken": _signal_int(dut, "fetch_sc_taken"),
            "lookup_ghist_spec": _signal_int(dut, "u_bpu.ghist_spec_q"),
            "lookup_ghist_arch": _signal_int(dut, "u_bpu.ghist_arch_q"),
            "lookup_h2p_override": _signal_int(dut, "u_bpu.h2p_override"),
            "lookup_h2p_taken": _signal_int(dut, "u_bpu.h2p_taken"),
            "lookup_h2p_score": _signal_int(dut, "u_bpu.u_h2p.lkp_score"),
            "lookup_sc_override": _signal_int(dut, "u_bpu.sc_override"),
            "lookup_tage_lowconf": _signal_int(dut, "u_bpu.tage_lowconf"),
        }
    dut.resolve_valid.value = 1
    dut.resolve_misp.value = 1 if misp else 0
    dut.resolve_asid.value = ctx["asid"]
    dut.resolve_vmid.value = ctx["vmid"]
    dut.resolve_priv.value = ctx["priv"]
    dut.resolve_secure.value = ctx["secure"]
    dut.resolve_workload_class.value = ctx["workload_class"]
    dut.resolve_pc.value = event.pc
    dut.resolve_target.value = actual_target
    dut.resolve_call_return_pc.value = return_pc
    dut.resolve_taken.value = 1 if actual_taken else 0
    dut.resolve_kind.value = event.kind
    dut.resolve_ftq_idx.value = resolve_ftq_idx
    dut.resolve_ras_restore_top.value = 0
    if prediction_debug is not None:
        await Timer(1, units="ns")
        prediction_debug.update(
            {
                "resolve_ftq_idx": resolve_ftq_idx,
                "resolve_ftq_replay_valid": _signal_int(dut, "u_bpu.ftq_replay_valid"),
                "resolve_replay_tage_provider": _signal_int(
                    dut, "u_bpu.replay_tage_provider"
                ),
                "resolve_replay_tage_lowconf": _signal_int(
                    dut, "u_bpu.replay_tage_lowconf"
                ),
                "resolve_replay_tage_hist": _signal_int(dut, "u_bpu.replay_tage_hist"),
                "resolve_ghist_arch": _signal_int(dut, "u_bpu.ghist_arch_q"),
                "resolve_replay_ittage_provider": _signal_int(
                    dut, "u_bpu.replay_ittage_provider"
                ),
                "resolve_h2p_update_score": _signal_int(dut, "u_bpu.u_h2p.upd_score"),
            }
        )
        debug_samples.append(prediction_debug)
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
        "h2p_override": await _read_counter(dut, PMU_H2P_OVERRIDE),
        "l2_ftb_hit": await _read_counter(dut, PMU_L2_FTB_HIT),
        "l2_ftb_miss": await _read_counter(dut, PMU_L2_FTB_MISS),
        "l2_ftb_late_redirect": await _read_counter(dut, PMU_L2_FTB_LATE_REDIRECT),
        "two_ahead_redirect": await _read_counter(dut, PMU_TWO_AHEAD_REDIRECT),
        "local_dir_override": await _read_counter(dut, PMU_LOCAL_DIR_OVERRIDE),
        "meta_train": await _read_counter(dut, PMU_META_TRAIN),
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


def _repo_relative_path(path: str | Path) -> Path:
    resolved = Path(path)
    if resolved.is_absolute():
        return resolved
    return _REPO_ROOT / resolved


def _resolve_output_path() -> Path:
    override = os.environ.get("ELIZA_BPU_MPKI_JSON")
    if override:
        return _repo_relative_path(override)
    return _REPO_ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"


def _resolve_debug_output_path() -> Path:
    override = os.environ.get("ELIZA_BPU_DEBUG_JSON")
    if override:
        return _repo_relative_path(override)
    return _REPO_ROOT / "docs/evidence/cpu_ap/bpu_h2p_sc_debug_replay.json"


def _debug_trace_names() -> list[str]:
    raw = os.environ.get(
        "ELIZA_BPU_DEBUG_TRACES",
        "alternating:correlated_xor_branches:vtable_path_correlated",
    )
    return [name for name in raw.split(":") if name]


def _debug_event_limit() -> int:
    return int(os.environ.get("ELIZA_BPU_DEBUG_EVENT_LIMIT", "2048"))


async def _run_cbp5_workload(
    dut, name: str, branches: list[BranchEvent], instruction_count: int
) -> dict:
    """Replay a CBP-5 trace through the RTL BPU. ``instruction_count`` is
    the true retired-instruction count from the .gz stream; MPKI is
    computed against it (not against branches*5).

    ``BR_IND`` (indirect-no-RAS) is driven through to the RTL using the
    3-bit ``br_kind_e`` encoding so the RAS only sees real calls and
    returns. Previous revisions of this harness collapsed ``BR_IND`` into
    ``BR_CALL`` because the RTL only had a 2-bit kind; that bug was the
    root cause of the 17-27x RTL/model MPKI divergence reported in
    ``docs/evidence/cpu_ap/mpki_cbp5_vs_tagesc_l_64kb.md``.
    """
    await _reset(dut)
    before = await _snapshot_counters(dut)

    misp_total = 0
    misp_ind = 0
    misp_ret = 0
    taken_count = 0
    for event in branches:
        misp = await _drive_event(dut, event)
        if event.taken:
            taken_count += 1
        if misp:
            misp_total += 1
            if event.kind in (BR_CALL, BR_IND):
                misp_ind += 1
            elif event.kind == BR_RET:
                misp_ret += 1

    await RisingEdge(dut.clk)
    after = await _snapshot_counters(dut)
    delta = _diff(after, before)

    branch_count = len(branches)
    pmu_misp = delta["br_misp"]
    mpki_pmu = (pmu_misp * 1000.0 / instruction_count) if instruction_count else 0.0
    mpki_harness = (misp_total * 1000.0 / instruction_count) if instruction_count else 0.0
    taken_throughput = (taken_count / branch_count) if branch_count else 0.0

    return {
        "workload": name,
        "trace_class": "cbp5_train_traces_only",
        "branch_count": branch_count,
        "instruction_count": instruction_count,
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
    }


def _resolve_cbp5_output_path() -> Path:
    override = os.environ.get("ELIZA_BPU_MPKI_CBP5_JSON")
    if override:
        return _repo_relative_path(override)
    return _REPO_ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json"


def _cbp5_trace_paths() -> list[Path]:
    env = os.environ.get("ELIZA_BPU_MPKI_CBP5_TRACES")
    if env:
        return [Path(p) for p in env.split(":") if p]
    default_dir = _REPO_ROOT / "external/cbp5-traces"
    if default_dir.is_dir():
        return sorted(default_dir.glob("*.gz"))
    return []


@cocotb.test()
async def bpu_mpki_synthetic_workload_sweep(dut):
    """Run all canonical synthetic workloads end-to-end through the RTL
    BPU and write ``mpki_results_synthetic.json`` with per-workload MPKI."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    results: dict[str, dict] = {}
    expected = list(SYNTHETIC_GENERATORS.keys())
    assert expected, "expected at least one synthetic workload"

    for name in expected:
        events = [_clone_branch_event(e) for e in SYNTHETIC_GENERATORS[name]()]
        results[name] = await _run_workload(dut, name, events)

    misp_total = sum(r["misprediction_count"] for r in results.values())
    instructions_total = sum(r["instruction_count_estimate"] for r in results.values())
    aggregate_mpki = (misp_total * 1000.0 / instructions_total) if instructions_total else 0.0

    envelope = {
        "schema": "eliza.bpu_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "cocotb-rtl-bpu_top",
        "rtl_top": "bpu_top",
        "evidence_class": "synthetic_planning_only",
        "claim_boundary": (
            "synthetic_planning_only RTL evidence exercises branch-predictor "
            "control shapes only; it is not SPEC2017, Android, JavaScript-engine, "
            "phone, or release evidence."
        ),
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
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
                "SPEC2017, AOSP, or JavaScript-engine traces. SPEC, Android, "
                "and JS-engine MPKI claims remain blocked until those trace "
                "sets are ingested into benchmarks/cpu/branch/. The CBP-5 "
                "TAGE-SC-L 64 KB "
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


@cocotb.test()
async def bpu_h2p_sc_debug_replay(dut):
    """Bounded H2P/SC/FTQ replay diagnostic for RTL/model convergence gaps.

    This is intentionally not a claim artifact. It records the internal lookup
    and resolve-time metadata needed to determine whether the remaining
    alternating/correlated/vtable gaps are caused by FTQ replay timing or by
    H2P/SC/ITTAGE scoring divergence.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    max_events = _debug_event_limit()
    results: dict[str, dict] = {}
    for name in _debug_trace_names():
        assert name in SYNTHETIC_GENERATORS, f"unknown BPU debug trace {name}"
        events = [_clone_branch_event(e) for e in SYNTHETIC_GENERATORS[name]()][:max_events]
        await _reset(dut)
        before = await _snapshot_counters(dut)
        samples: list[dict] = []
        misp_total = 0
        for sequence, event in enumerate(events):
            misp = await _drive_event(
                dut,
                event,
                debug_samples=samples,
                trace_name=name,
                sequence=sequence,
            )
            if misp:
                misp_total += 1
        await RisingEdge(dut.clk)
        delta = _diff(await _snapshot_counters(dut), before)
        replay_valid = sum(1 for sample in samples if sample["resolve_ftq_replay_valid"] == 1)
        h2p_lookup = sum(1 for sample in samples if sample["lookup_h2p_override"] == 1)
        sc_lookup = sum(1 for sample in samples if sample["lookup_sc_override"] == 1)
        h2p_misp = sum(
            1
            for sample in samples
            if sample["lookup_h2p_override"] == 1 and sample["misp"]
        )
        sc_misp = sum(
            1
            for sample in samples
            if sample["lookup_sc_override"] == 1 and sample["misp"]
        )
        results[name] = {
            "trace_class": "synthetic_debug_only",
            "branch_count": len(events),
            "misprediction_count_harness_observed": misp_total,
            "pmu_counters_delta": delta,
            "debug_summary": {
                "ftq_replay_valid_events": replay_valid,
                "ftq_replay_valid_ratio": round(replay_valid / max(1, len(samples)), 6),
                "lookup_h2p_override_events": h2p_lookup,
                "lookup_sc_override_events": sc_lookup,
                "mispredictions_with_h2p_lookup_override": h2p_misp,
                "mispredictions_with_sc_lookup_override": sc_misp,
            },
            "samples": samples,
        }

    envelope = {
        "schema": "eliza.bpu_h2p_sc_debug_replay.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "cocotb-rtl-bpu_top",
        "rtl_top": "bpu_top",
        "claim_policy": {
            "claim_allowed": False,
            "reason": (
                "Internal synthetic debug replay for BPU RTL/model convergence. "
                "This artifact is diagnostic only and must not back performance, "
                "SPEC, Android, JavaScript, CBP-5, or phone-class claims."
            ),
        },
        "traces": results,
    }
    out_path = _resolve_debug_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
    dut._log.info(f"bpu_h2p_sc_debug: wrote {out_path}")


@cocotb.test()
async def bpu_mpki_cbp5_real_traces(dut):
    """Replay real CBP-5 train traces through the RTL BPU.

    Gated on the presence of trace files; when neither
    ``ELIZA_BPU_MPKI_CBP5_TRACES`` nor ``external/cbp5-traces/*.gz`` are
    available the test exits early with a skip annotation. Output is
    written to ``docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json`` (override
    via ``ELIZA_BPU_MPKI_CBP5_JSON``).

    These are CBP-5 train-set numbers only; ``evidence_class`` is
    ``cbp5_train_traces_only`` and the envelope refuses SPEC/AOSP/V8
    claims even when the run succeeds.
    """
    trace_paths = _cbp5_trace_paths()
    if not trace_paths:
        dut._log.info(
            "bpu_mpki_cbp5: no .gz traces under external/cbp5-traces; skipping. "
            "See docs/evidence/cpu_ap/mpki_cbp5_vs_tagesc_l_64kb.md for download steps."
        )
        return

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    results: dict[str, dict] = {}
    for path in trace_paths:
        dut._log.info(f"bpu_mpki_cbp5: ingesting {path.name}")
        branches, stats = read_cbp5_with_count(path)
        dut._log.info(
            f"bpu_mpki_cbp5: {path.name}: inst={stats.instruction_count} "
            f"branches={stats.branch_count} (replay starts)"
        )
        result = await _run_cbp5_workload(dut, path.stem, branches, stats.instruction_count)
        result["branch_stats"] = stats.as_dict()
        results[path.stem] = result

    aggregate_inst = sum(r["instruction_count"] for r in results.values())
    aggregate_misp = sum(r["misprediction_count"] for r in results.values())
    aggregate_branches = sum(r["branch_count"] for r in results.values())
    aggregate_mpki = (aggregate_misp * 1000.0 / aggregate_inst) if aggregate_inst else 0.0
    cbp5_claim = bool(aggregate_inst and aggregate_mpki <= TARGET_2028_MPKI)

    envelope = {
        "schema": "eliza.bpu_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "cocotb-rtl-bpu_top",
        "rtl_top": "bpu_top",
        "evidence_class": "cbp5_train_traces_only",
        "claim_boundary": (
            "cbp5_train_traces_only RTL evidence is not SPEC2017, Android, "
            "JavaScript-engine, phone, or release evidence."
        ),
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "cbp5_tage_sc_l_reference_mpki": CBP5_TAGE_SC_L_REFERENCE_MPKI,
        "target_2028_mpki": TARGET_2028_MPKI,
        "aggregate": {
            "branch_count": aggregate_branches,
            "instruction_count": aggregate_inst,
            "misprediction_count": aggregate_misp,
            "mpki": round(aggregate_mpki, 6),
        },
        "workloads": results,
        "claim_policy": {
            "evidence_class": "cbp5_train_traces_only",
            "cbp5_claim": cbp5_claim,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "Real CBP-5 (CBP2025) train-trace MPKI measured on the BPU "
                "RTL via the cocotb harness. Numbers compare directly to the "
                "CBP2016 64KB TAGE-SC-L reference in "
                "reference_results_training_set.csv. CBP-5 train traces are "
                "not SPEC2017, AOSP, or JS-engine workloads; this evidence "
                "supports a CBP-5 target-met claim only when aggregate MPKI "
                "is at or below target_2028_mpki."
            ),
        },
    }

    out_path = _resolve_cbp5_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")

    dut._log.info(f"bpu_mpki_cbp5: wrote {out_path}")
    dut._log.info(f"bpu_mpki_cbp5: aggregate MPKI = {aggregate_mpki:.3f}")
    for name, r in results.items():
        dut._log.info(
            f"bpu_mpki_cbp5: {name}: branches={r['branch_count']} "
            f"misp={r['misprediction_count']} mpki={r['mpki']:.3f}"
        )


def _resolve_workload_output_path() -> Path:
    override = os.environ.get("ELIZA_BPU_MPKI_WORKLOAD_JSON")
    if override:
        return _repo_relative_path(override)
    return _REPO_ROOT / "docs/evidence/cpu_ap/mpki_results_workload_rtl.json"


def _workload_trace_paths() -> list[Path]:
    """QEMU-RV64 ``.btrace.json`` workload traces to replay through the RTL.

    Selection mirrors the model/comparison harnesses so the RTL ingests the
    *same* real-workload traces. ``ELIZA_BPU_MPKI_WORKLOAD_TRACES`` (``:``-
    separated paths) pins an explicit set; otherwise every ``.btrace.json``
    under ``external/workload-traces`` is replayed.
    """
    env = os.environ.get("ELIZA_BPU_MPKI_WORKLOAD_TRACES")
    if env:
        return [Path(p) for p in env.split(":") if p]
    default_dir = _REPO_ROOT / "external/workload-traces"
    if default_dir.is_dir():
        return sorted(default_dir.glob("*.btrace.json"))
    return []


def _workload_branch_cap() -> int:
    return int(os.environ.get("ELIZA_BPU_MPKI_WORKLOAD_MAX_BRANCHES", "0"))


def _workload_window_mode() -> str:
    mode = os.environ.get("ELIZA_BPU_MPKI_WORKLOAD_WINDOW_MODE", "prefix").strip().lower()
    if mode not in {"prefix", "middle", "late", "stratified"}:
        raise ValueError(
            "ELIZA_BPU_MPKI_WORKLOAD_WINDOW_MODE must be one of "
            "prefix, middle, late, stratified"
        )
    return mode


def _clone_branch_event(event: BranchEvent) -> BranchEvent:
    return BranchEvent(
        pc=int(event.pc),
        target=int(event.target),
        taken=bool(event.taken),
        kind=int(event.kind),
        call_return_pc=event.call_return_pc,
        asid=int(getattr(event, "asid", 0)),
        vmid=int(getattr(event, "vmid", 0)),
        priv=int(getattr(event, "priv", 0)),
        secure=int(getattr(event, "secure", 0)),
        workload_class=int(getattr(event, "workload_class", 0)),
    )


def _proportional_instruction_count(
    total_instruction_count: int,
    selected_branch_count: int,
    source_branch_count: int,
) -> int:
    if source_branch_count <= 0:
        return 0
    return max(1, int(total_instruction_count * (selected_branch_count / source_branch_count)))


def _select_workload_window(
    branches: list[BranchEvent],
    instruction_count: int,
    max_branches: int,
    window_mode: str,
) -> tuple[list[BranchEvent], int, dict[str, object]]:
    source_branch_count = len(branches)
    if not max_branches or source_branch_count <= max_branches:
        return branches, instruction_count, {
            "branch_replay_cap": max_branches or None,
            "branch_replay_window_mode": "full",
            "trace_prefix_replay": False,
            "trace_window_replay": False,
        }

    count = max(1, min(max_branches, source_branch_count))
    if window_mode == "stratified":
        per = max(1, count // 3)
        selected: list[BranchEvent] = []
        used: set[int] = set()
        for start_frac in (0.0, 0.5, 1.0):
            chunk_count = min(per, source_branch_count)
            max_start = source_branch_count - chunk_count
            start = int(max_start * start_frac)
            for idx in range(start, start + chunk_count):
                if idx not in used and len(selected) < count:
                    selected.append(branches[idx])
                    used.add(idx)
        selected_branches = selected
    else:
        start_frac = {"prefix": 0.0, "middle": 0.5, "late": 1.0}[window_mode]
        max_start = source_branch_count - count
        start = int(max_start * start_frac)
        selected_branches = branches[start : start + count]

    selected_instruction_count = _proportional_instruction_count(
        instruction_count,
        len(selected_branches),
        source_branch_count,
    )
    return selected_branches, selected_instruction_count, {
        "branch_replay_cap": max_branches,
        "branch_replay_window_mode": window_mode,
        "trace_prefix_replay": window_mode == "prefix",
        "trace_window_replay": window_mode != "prefix",
    }


@cocotb.test()
async def bpu_mpki_workload_traces(dut):
    """Replay real QEMU-RV64 ``.btrace.json`` workload traces through the RTL BPU.

    These are the *same* traces the behavioural model and the head-to-head
    ``compare_mpki.py`` harness use, so the RTL MPKI here is directly
    comparable to the E1-model MPKI in
    ``docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json`` on a per-trace basis. This
    is what lifts the E1 side of the win from a behavioural model to RTL.

    Gated on the presence of trace files; when none are available the test
    exits early with a skip annotation. Output is written to
    ``docs/evidence/cpu_ap/mpki_results_workload_rtl.json`` (override via
    ``ELIZA_BPU_MPKI_WORKLOAD_JSON``).
    """
    trace_paths = _workload_trace_paths()
    if not trace_paths:
        dut._log.info(
            "bpu_mpki_workload: no .btrace.json under external/workload-traces; "
            "skipping. Capture with `make bpu-workload-trace`."
        )
        return

    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    results: dict[str, dict] = {}
    for path in trace_paths:
        name = path.name[: -len(".btrace.json")]
        dut._log.info(f"bpu_mpki_workload: ingesting {path.name}")
        branches, instruction_count = read_workload_trace(path)
        source_branch_count = len(branches)
        source_instruction_count = instruction_count
        max_branches = _workload_branch_cap()
        window_mode = _workload_window_mode()
        branches, instruction_count, replay_window = _select_workload_window(
            branches,
            source_instruction_count,
            max_branches,
            window_mode,
        )
        dut._log.info(
            f"bpu_mpki_workload: {name}: inst={instruction_count} "
            f"branches={len(branches)} window={replay_window['branch_replay_window_mode']} "
            "(replay starts)"
        )
        result = await _run_cbp5_workload(dut, name, branches, instruction_count)
        result["trace_class"] = "qemu_rv64_workload"
        result["source_branch_count"] = source_branch_count
        result["source_instruction_count"] = source_instruction_count
        replay_fraction = (
            len(branches) / source_branch_count if source_branch_count else 0.0
        )
        instruction_replay_fraction = (
            instruction_count / source_instruction_count if source_instruction_count else 0.0
        )
        result["replay_fraction"] = round(replay_fraction, 6)
        result["instruction_replay_fraction"] = round(instruction_replay_fraction, 6)
        result["full_trace_replay"] = bool(source_branch_count == len(branches))
        result.update(replay_window)
        results[name] = result

    aggregate_inst = sum(r["instruction_count"] for r in results.values())
    aggregate_misp = sum(r["misprediction_count"] for r in results.values())
    aggregate_branches = sum(r["branch_count"] for r in results.values())
    aggregate_source_inst = sum(r["source_instruction_count"] for r in results.values())
    aggregate_source_branches = sum(r["source_branch_count"] for r in results.values())
    aggregate_replay_fraction = (
        aggregate_branches / aggregate_source_branches if aggregate_source_branches else 0.0
    )
    aggregate_instruction_replay_fraction = (
        aggregate_inst / aggregate_source_inst if aggregate_source_inst else 0.0
    )
    aggregate_mpki = (aggregate_misp * 1000.0 / aggregate_inst) if aggregate_inst else 0.0

    envelope = {
        "schema": "eliza.bpu_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "cocotb-rtl-bpu_top",
        "rtl_top": "bpu_top",
        "evidence_class": "qemu_rv64_workload",
        "claim_boundary": WORKLOAD_RTL_CLAIM_BOUNDARY,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "instructions_per_branch_assumption": None,
        "branch_replay_cap": _workload_branch_cap() or None,
        "branch_replay_window_mode": _workload_window_mode(),
        "source_branch_count": aggregate_source_branches,
        "source_instruction_count": aggregate_source_inst,
        "replayed_branch_count": aggregate_branches,
        "replayed_instruction_count": aggregate_inst,
        "replay_fraction": round(aggregate_replay_fraction, 6),
        "instruction_replay_fraction": round(aggregate_instruction_replay_fraction, 6),
        "full_trace_replay": bool(
            aggregate_source_branches > 0 and aggregate_branches == aggregate_source_branches
        ),
        "aggregate": {
            "branch_count": aggregate_branches,
            "instruction_count": aggregate_inst,
            "misprediction_count": aggregate_misp,
            "mpki": round(aggregate_mpki, 6),
        },
        "workloads": results,
        "claim_policy": {
            "evidence_class": "qemu_rv64_workload",
            "cbp5_claim": False,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "Real QEMU-RV64 duty-cycle workload MPKI measured on the BPU RTL "
                "via the cocotb harness, over the same .btrace.json traces the "
                "behavioural model uses. Instruction counts are the true retired "
                "counts decoded from the QEMU execlog, so MPKI is comparable to "
                "the E1-model MPKI in bpu-vs-cva6-mpki.json when branch_replay_cap "
                "is null. A non-null branch_replay_cap means deterministic capped "
                "window replay for coverage turnaround, not a full-trace MPKI claim. "
                "These are the E1's own agent-loop / IO duty-cycle workloads; "
                "they are not SPEC2017, AOSP, or JS-engine traces."
            ),
        },
    }

    out_path = _resolve_workload_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")

    dut._log.info(f"bpu_mpki_workload: wrote {out_path}")
    dut._log.info(f"bpu_mpki_workload: aggregate MPKI = {aggregate_mpki:.3f}")
    for name, r in results.items():
        dut._log.info(
            f"bpu_mpki_workload: {name}: branches={r['branch_count']} "
            f"misp={r['misprediction_count']} mpki={r['mpki']:.3f}"
        )
