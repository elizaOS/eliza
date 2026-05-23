#!/usr/bin/env python3
"""Branch-predictor experiment harness: sweep BPU geometry against the trace
set and rank configurations by misprediction rate.

This is the optimisation loop for the E1 BPU. It runs the behavioural
:class:`BPUSimulator` under a set of candidate geometries over a trace set
that spans the E1's real duty cycle and standard hard references:

  * ``agent_loop``  — real RV64 trace of the llama.cpp agent duty cycle
                      (GEMV-dominated, the common case).
  * ``agent_decode``— real RV64 trace weighted to the hard, data-dependent
                      tokenizer/sampler/stream branches.
  * ``cbp5:*``      — CBP2025 championship training-trace samples (the hard
                      discriminating reference; compared to the published
                      64 KB TAGE-SC-L results).

For each config it reports per-trace MPKI and a workload-weighted aggregate,
then writes a leaderboard and an evidence envelope. Tuning runs on a capped
branch prefix for turnaround; re-run the winner with ``--max-branches 0`` on
the full traces to lock the number.

Config knobs map one-to-one to ``rtl/cpu/bpu/bpu_pkg.sv`` parameters, so a
winning config is a direct RTL proposal.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.bpu_model import (  # noqa: E402
    DEFAULT_GEOMETRY,
    BPUSimulator,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import SYNTHETIC_GENERATORS, read_cbp5_with_count  # noqa: E402
from benchmarks.cpu.branch.workload_trace import read_workload_trace  # noqa: E402

EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
SWEEP_JSON = EVIDENCE_DIR / "bpu_sweep_results.json"
LEADERBOARD_MD = EVIDENCE_DIR / "bpu_sweep_leaderboard.md"
WORKLOAD_DIR = ROOT / "external/workload-traces"
CBP5_DIR = ROOT / "external/cbp5-traces"

# CBP2016 64 KB TAGE-SC-L reference MPKI on the CBP2025 sample traces, used as
# the SOTA bar for the hard references (from run_mpki.CBP5_REFERENCE_PER_TRACE).
CBP5_REFERENCE = {"sample_int_trace": 5.1327, "sample_fp_trace": 0.5736}

# Real RV64 workloads to include (besides the CBP-5 references). The two agent
# traces are the inference duty cycle; the io_stream traces are the streaming/
# IO/parsing duty cycle, where irregular control flow leaves real headroom.
WORKLOAD_NAMES = (
    "agent_loop",
    "agent_decode",
    "http_parser",
    "text_log",
    "file_tlv",
    "video_blocks",
    "audio_frames",
)

SYNTHETIC_SWEEP_WORKLOADS = (
    "always_taken",
    "always_not_taken",
    "alternating",
    "loop_with_known_trip",
    "deep_recursion",
    "v8_indirect_dispatch",
    "mixed_workload",
    "jit_dispatch_warmup",
    "gpu_tile_kernel",
    "gpu_warp_divergence",
    "gpu_command_processor",
    "dual_branch_fetch_block",
    "nested_imli_loop",
    "correlated_xor_branches",
    "vtable_path_correlated",
    "interpreter_dispatch_mixed",
    "phase_change_server",
    "alias_thrash",
    "gpu_occupancy_phase",
    "return_mismatch_exceptions",
)

# Default per-trace weights for the aggregate objective: the E1's own workloads
# are the optimisation target, so they outweigh the championship references.
DEFAULT_WEIGHTS = {
    "agent_loop": 2.0,
    "agent_decode": 1.5,
    "http_parser": 1.5,
    "text_log": 1.5,
    "file_tlv": 1.5,
    "video_blocks": 1.5,
    "audio_frames": 1.5,
    # Synthetic traces keep the objective honest around known hard shapes.
    # GPU-oriented traces get enough weight to steer tie-breaks without
    # overpowering the real RV64 and CBP-5 references.
    "synthetic:always_taken": 0.25,
    "synthetic:always_not_taken": 0.25,
    "synthetic:alternating": 0.35,
    "synthetic:loop_with_known_trip": 0.5,
    "synthetic:deep_recursion": 0.35,
    "synthetic:v8_indirect_dispatch": 0.5,
    "synthetic:mixed_workload": 0.75,
    "synthetic:jit_dispatch_warmup": 0.75,
    "synthetic:gpu_tile_kernel": 1.0,
    "synthetic:gpu_warp_divergence": 1.0,
    "synthetic:gpu_command_processor": 1.0,
    "synthetic:dual_branch_fetch_block": 0.75,
    "synthetic:nested_imli_loop": 0.75,
    "synthetic:correlated_xor_branches": 0.75,
    "synthetic:vtable_path_correlated": 0.75,
    "synthetic:interpreter_dispatch_mixed": 0.75,
    "synthetic:phase_change_server": 0.75,
    "synthetic:alias_thrash": 0.5,
    "synthetic:gpu_occupancy_phase": 0.75,
    "synthetic:return_mismatch_exceptions": 0.35,
    "cbp5:sample_int_trace": 1.0,
    "cbp5:sample_fp_trace": 1.0,
}


def _geo(**overrides) -> dict:
    g = dict(DEFAULT_GEOMETRY)
    g.update(overrides)
    return g


PRE_OPT_R8_GEOMETRY = _geo(
    TAGE_ALLOC_DECREMENT=False,
    TAGE_UBIT_RESET_PERIOD=262_144,
    TAGE_HIST_LEN=(8, 13, 32, 64, 119),
    TAGE_ENTRIES_TABLE=4096,
    SC_ADAPTIVE=False,
)

PRE_TARGET_HISTORY_GEOMETRY = _geo(
    SC_THRESH_INIT=6,
    ITTAGE_TARGET_HISTORY_BITS=0,
)

PRE_ITTAGE_HIST_LONG_GEOMETRY = _geo(
    ITTAGE_HIST_LEN=(4, 8, 13, 16, 32),
)


# Candidate configurations. Each knob is a real bpu_pkg.sv parameter; lists
# that change a table count carry a matching-length history schedule.
CONFIGS: dict[str, dict] = {
    "baseline": _geo(),
    "pre_ittage_hist_long": PRE_ITTAGE_HIST_LONG_GEOMETRY,
    "pre_opt_r8": PRE_OPT_R8_GEOMETRY,
    "pre_target_history": PRE_TARGET_HISTORY_GEOMETRY,
    # ---- TAGE direction: history reach + capacity ----
    "tage_reach_long": _geo(TAGE_HIST_LEN=(8, 16, 44, 90, 195)),
    "tage_reach_xlong": _geo(TAGE_HIST_LEN=(10, 20, 50, 120, 260)),
    "tage6_tables": _geo(TAGE_TABLES=6, TAGE_HIST_LEN=(8, 13, 24, 48, 96, 195)),
    "tage7_tables": _geo(TAGE_TABLES=7, TAGE_HIST_LEN=(6, 11, 18, 32, 64, 128, 256)),
    "tage_big_tables": _geo(TAGE_ENTRIES_TABLE=8192),
    "bim_big": _geo(BIM_ENTRIES=32768),
    # ---- Statistical corrector ----
    "sc_thresh_low": _geo(SC_THRESH_INIT=4),
    "sc_thresh_mid": _geo(SC_THRESH_INIT=6),
    "sc_thresh_high": _geo(SC_THRESH_INIT=8),
    "sc_thresh_xhigh": _geo(SC_THRESH_INIT=10),
    "sc_thresh_12": _geo(SC_THRESH_INIT=12),
    "sc_adaptive": _geo(SC_ADAPTIVE=True),
    "sc_no_local_hist": _geo(SC_LOCAL_HISTORY_BITS=0),
    "sc_local_hist8": _geo(SC_LOCAL_HISTORY_BITS=8),
    "sc_local_hist12": _geo(SC_LOCAL_HISTORY_BITS=12),
    "sc_local_hist8_big": _geo(SC_LOCAL_HISTORY_BITS=8, SC_LOCAL_HISTORY_ENTRIES=2048),
    "sc_wide": _geo(
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
    ),
    "sc_wide_thresh6": _geo(
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
        SC_THRESH_INIT=6,
    ),
    "sc_wide_long": _geo(
        SC_TABLES=8,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44, 72, 119),
    ),
    # ---- Loop predictor ----
    "loop_big": _geo(LOOP_ENTRIES=128),
    # ---- Fetch block front-end bandwidth ----
    "fetch_block_dual_branch": _geo(FETCH_BLOCK_BRANCH_SLOTS=2),
    # ---- TAGE allocation/aging policy (algorithmic, not just geometry) ----
    "tage_alloc_decr": _geo(TAGE_ALLOC_DECREMENT=True),
    "tage_ubit_reset": _geo(TAGE_UBIT_RESET_PERIOD=100_000),
    "tage_ubit_reset_fast": _geo(TAGE_UBIT_RESET_PERIOD=20_000),
    "tage_ubit_reset_slow": _geo(TAGE_UBIT_RESET_PERIOD=500_000),
    "tage_alloc_aging": _geo(TAGE_ALLOC_DECREMENT=True, TAGE_UBIT_RESET_PERIOD=100_000),
    "tage_alloc_rtl_aging": _geo(TAGE_ALLOC_DECREMENT=True),
    "tage_use_alt_on_na": _geo(TAGE_USE_ALT_ON_NA=1),
    # ---- ITTAGE target-history ablations ----
    "ittage_no_target_hist": _geo(ITTAGE_TARGET_HISTORY_BITS=0),
    "ittage_target_hist32": _geo(ITTAGE_TARGET_HISTORY_BITS=32),
    "ittage_target_hist96": _geo(ITTAGE_TARGET_HISTORY_BITS=96),
    "ittage_target_hist128": _geo(ITTAGE_TARGET_HISTORY_BITS=128),
    "ittage_target_token5": _geo(ITTAGE_TARGET_HISTORY_TOKEN_BITS=5),
    "ittage_target_token9": _geo(ITTAGE_TARGET_HISTORY_TOKEN_BITS=9),
    "ittage_target_shift2": _geo(ITTAGE_TARGET_HISTORY_SHIFT=2),
    "ittage_target_shift5": _geo(ITTAGE_TARGET_HISTORY_SHIFT=5),
    "ittage_target_shift8": _geo(ITTAGE_TARGET_HISTORY_SHIFT=8),
    "ittage_path_hist32": _geo(ITTAGE_PATH_HISTORY_BITS=32),
    "ittage_path_hist64": _geo(ITTAGE_PATH_HISTORY_BITS=64),
    "ittage_path_token4": _geo(ITTAGE_PATH_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_TOKEN_BITS=4),
    "ittage_path_token8": _geo(ITTAGE_PATH_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_TOKEN_BITS=8),
    "ittage_target_path": _geo(ITTAGE_TARGET_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_BITS=64),
    "ittage_big": _geo(ITTAGE_ENTRIES=(1024, 1024, 2048, 2048, 2048)),
    "ittage_tag11": _geo(ITTAGE_TAG_W=11),
    "ittage_hist_long": _geo(ITTAGE_HIST_LEN=(4, 10, 20, 40, 80)),
    "ittage6_tables": _geo(
        ITTAGE_TABLES=6,
        ITTAGE_ENTRIES=(512, 512, 1024, 1024, 1024, 1024),
        ITTAGE_HIST_LEN=(4, 8, 13, 20, 32, 64),
    ),
    "ittage_no_weak_replace": _geo(ITTAGE_REPLACE_WEAK_CTR=0),
    "ittage_weak_replace2": _geo(ITTAGE_REPLACE_WEAK_CTR=2),
    "ittage_replace_all_providers": _geo(ITTAGE_REPLACE_MIN_PROVIDER=1),
    "ittage_replace_provider5": _geo(ITTAGE_REPLACE_MIN_PROVIDER=5),
    "ittage_weak_replace4": _geo(ITTAGE_REPLACE_WEAK_CTR=4),
    # ---- Promising combination (TAGE reach + adaptive SC + bigger tables) ----
    "combo_a": _geo(
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
    ),
    "combo_b": _geo(
        TAGE_TABLES=6,
        TAGE_HIST_LEN=(8, 13, 24, 48, 96, 195),
        SC_ADAPTIVE=True,
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
    ),
    # ---- Algorithmic + geometry stack: the candidate "beat baseline" config ----
    "combo_algo": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        SC_ADAPTIVE=True,
    ),
    "combo_algo_geo": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
    ),
    "combo_algo_geo_dual_fetch": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
        FETCH_BLOCK_BRANCH_SLOTS=2,
    ),
}


@dataclass
class LoadedTrace:
    name: str
    events: list[BranchEvent]
    inst_count: int  # effective instruction count for the (possibly capped) prefix
    weight: float


def _cap(events: list[BranchEvent], total_inst: int, max_branches: int):
    if max_branches and len(events) > max_branches:
        frac = max_branches / len(events)
        return events[:max_branches], int(total_inst * frac)
    return events, total_inst


def load_traces(max_branches: int, weights: dict[str, float]) -> list[LoadedTrace]:
    traces: list[LoadedTrace] = []
    for name in WORKLOAD_NAMES:
        p = WORKLOAD_DIR / f"{name}.btrace.json"
        if not p.is_file():
            continue
        events, inst = read_workload_trace(p)
        events, inst = _cap(events, inst, max_branches)
        traces.append(LoadedTrace(name, events, inst, weights.get(name, 1.0)))
    for name in SYNTHETIC_SWEEP_WORKLOADS:
        events = list(SYNTHETIC_GENERATORS[name]())
        events, inst = _cap(events, len(events) * 5, max_branches)
        key = f"synthetic:{name}"
        traces.append(LoadedTrace(key, events, inst, weights.get(key, 0.5)))
    for p in sorted(CBP5_DIR.glob("*.gz")):
        events, stats = read_cbp5_with_count(p)
        events, inst = _cap(events, stats.instruction_count, max_branches)
        key = f"cbp5:{p.stem}"
        traces.append(LoadedTrace(key, events, inst, weights.get(key, 1.0)))
    return traces


# Globals populated per worker process (inherited via fork).
_WORKER_TRACES: list[LoadedTrace] = []


def _init_worker(traces: list[LoadedTrace]) -> None:
    global _WORKER_TRACES
    _WORKER_TRACES = traces


def _eval_config(item: tuple[str, dict]) -> tuple[str, dict]:
    name, geometry = item
    per_trace: dict[str, dict] = {}
    for tr in _WORKER_TRACES:
        sim = BPUSimulator(geometry=dict(geometry))
        sim.feed(tr.events)
        mpki = sim.mpki(tr.inst_count) if tr.inst_count else 0.0
        c = sim.stats()
        per_trace[tr.name] = {
            "mpki": round(mpki, 6),
            "misp": int(c.get("misp", 0)),
            "branches": len(tr.events),
            "instructions": tr.inst_count,
            "weight": tr.weight,
        }
    wsum = sum(tr.weight for tr in _WORKER_TRACES)
    weighted = sum(per_trace[tr.name]["mpki"] * tr.weight for tr in _WORKER_TRACES) / max(
        wsum, 1e-9
    )
    return name, {"weighted_mpki": round(weighted, 6), "per_trace": per_trace}


def run_sweep(
    configs: dict[str, dict],
    traces: list[LoadedTrace],
    jobs: int,
) -> dict[str, dict]:
    items = list(configs.items())
    if jobs > 1 and len(items) > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(processes=jobs, initializer=_init_worker, initargs=(traces,)) as pool:
            results = dict(pool.map(_eval_config, items))
    else:
        _init_worker(traces)
        results = dict(_eval_config(it) for it in items)
    return results


def _diff_from_default(geometry: dict) -> dict:
    return {
        k: (list(v) if isinstance(v, tuple) else v)
        for k, v in geometry.items()
        if DEFAULT_GEOMETRY.get(k) != v
    }


def write_leaderboard(
    results: dict[str, dict],
    traces: list[LoadedTrace],
    ranking: list[str],
    max_branches: int,
) -> None:
    base = results["baseline"]["weighted_mpki"]
    lines = [
        "# BPU geometry sweep leaderboard",
        "",
        "Generated by `benchmarks/cpu/branch/sweep.py`. Each config is a "
        "`bpu_pkg.sv` geometry; MPKI is from the behavioural TAGE-SC-L+ITTAGE "
        "model over the E1 trace set. Lower is better; the aggregate is "
        "workload-weighted (the E1 duty cycle outweighs the references).",
        "",
        f"- Branch cap per trace: {'full trace' if not max_branches else f'{max_branches:,} branches'}",
        f"- Baseline weighted MPKI: {base:.4f}",
        "",
        "## Ranking (by weighted MPKI)",
        "",
    ]
    trace_names = [t.name for t in traces]
    header = "| rank | config | weighted MPKI | Δ vs baseline | " + " | ".join(trace_names) + " |"
    lines.append(header)
    lines.append("| " + " | ".join(["---"] * (4 + len(trace_names))) + " |")
    for i, name in enumerate(ranking, 1):
        r = results[name]
        delta = r["weighted_mpki"] - base
        cells = [f"{r['per_trace'][tn]['mpki']:.4f}" for tn in trace_names]
        lines.append(
            f"| {i} | `{name}` | {r['weighted_mpki']:.4f} | {delta:+.4f} | "
            + " | ".join(cells)
            + " |"
        )
    lines += [
        "",
        "## CBP-5 reference bar (64 KB TAGE-SC-L)",
        "",
        "| trace | reference MPKI | best config MPKI |",
        "| --- | --- | --- |",
    ]
    best = ranking[0]
    for tn in trace_names:
        if tn.startswith("cbp5:"):
            stem = tn.split(":", 1)[1]
            ref = CBP5_REFERENCE.get(stem)
            got = results[best]["per_trace"][tn]["mpki"]
            lines.append(f"| {tn} | {ref if ref is not None else 'n/a'} | {got:.4f} |")
    lines += [
        "",
        f"Winning config: **`{best}`** "
        f"(weighted MPKI {results[best]['weighted_mpki']:.4f}, "
        f"{results[best]['weighted_mpki'] - base:+.4f} vs baseline).",
        "",
        "Diff from baseline geometry:",
        "",
        "```json",
        json.dumps(_diff_from_default(CONFIGS[best]), indent=2),
        "```",
        "",
    ]
    LEADERBOARD_MD.parent.mkdir(parents=True, exist_ok=True)
    LEADERBOARD_MD.write_text("\n".join(lines) + "\n")


def _print_summary(results: dict[str, dict], ranking: list[str]) -> None:
    base = results["baseline"]
    base_weighted = base["weighted_mpki"]
    print("\neliza-bpu-sweep: top candidates")
    for name in ranking[:10]:
        r = results[name]
        regressions = []
        for trace, values in r["per_trace"].items():
            delta = values["mpki"] - base["per_trace"][trace]["mpki"]
            if delta > 0:
                regressions.append((trace, delta))
        worst = sorted(regressions, key=lambda x: x[1], reverse=True)[:3]
        worst_text = ", ".join(f"{trace} +{delta:.4f}" for trace, delta in worst) or "none"
        print(
            f"  {name:24s} weighted={r['weighted_mpki']:.4f} "
            f"delta={r['weighted_mpki'] - base_weighted:+.4f} regressions={worst_text}"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--max-branches",
        type=int,
        default=1_200_000,
        help="cap branches per trace for turnaround (0 = full trace)",
    )
    ap.add_argument("--jobs", type=int, default=min(8, mp.cpu_count()))
    ap.add_argument(
        "--configs",
        nargs="*",
        default=list(CONFIGS.keys()),
        help="subset of config names to run (default: all)",
    )
    ap.add_argument(
        "--print-only",
        action="store_true",
        help="do not write evidence or leaderboard files",
    )
    args = ap.parse_args()

    for name in args.configs:
        if name not in CONFIGS:
            print(f"unknown config: {name}", file=sys.stderr)
            return 2
    if "baseline" not in args.configs:
        args.configs = ["baseline", *args.configs]
    selected = {k: CONFIGS[k] for k in args.configs}

    print(f"eliza-bpu-sweep: loading traces (cap={args.max_branches or 'full'})")
    traces = load_traces(args.max_branches, DEFAULT_WEIGHTS)
    if not traces:
        print("STATUS: BLOCKED bpu.sweep - no traces found", file=sys.stderr)
        return 2
    for t in traces:
        print(f"  {t.name:28s} branches={len(t.events):>9,} inst={t.inst_count:>11,} w={t.weight}")

    print(f"eliza-bpu-sweep: evaluating {len(selected)} configs on {args.jobs} jobs")
    results = run_sweep(selected, traces, args.jobs)
    ranking = sorted(results, key=lambda n: results[n]["weighted_mpki"])

    base = results["baseline"]["weighted_mpki"]
    best = ranking[0]
    envelope = {
        "schema": "eliza.bpu_sweep.v1",
        "status": "pass",
        "claim_boundary": (
            "behavioural BPU geometry sweep only; SPEC/AOSP/JetStream real-workload "
            "MPKI claims remain blocked until those trace sets are captured"
        ),
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "behavioural-bpu-model",
        "max_branches_per_trace": args.max_branches,
        "trace_set": [
            {
                "name": t.name,
                "branches": len(t.events),
                "instructions": t.inst_count,
                "weight": t.weight,
            }
            for t in traces
        ],
        "weights": DEFAULT_WEIGHTS,
        "cbp5_reference_mpki": CBP5_REFERENCE,
        "baseline_weighted_mpki": base,
        "best_config": best,
        "best_weighted_mpki": results[best]["weighted_mpki"],
        "best_delta_vs_baseline": round(results[best]["weighted_mpki"] - base, 6),
        "best_geometry_diff": _diff_from_default(CONFIGS[best]),
        "ranking": ranking,
        "results": results,
    }
    if not args.print_only:
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        SWEEP_JSON.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
        write_leaderboard(results, traces, ranking, args.max_branches)

    print("\neliza-bpu-sweep: ranking (weighted MPKI)")
    for i, name in enumerate(ranking, 1):
        r = results[name]
        print(f"  {i:2d}. {name:18s} {r['weighted_mpki']:.4f}  ({r['weighted_mpki'] - base:+.4f})")
    _print_summary(results, ranking)
    if args.print_only:
        print(f"\neliza-bpu-sweep: status=PASS best={best} (print-only)")
    else:
        print(f"\neliza-bpu-sweep: status=PASS best={best} -> {SWEEP_JSON.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
